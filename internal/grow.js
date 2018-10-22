/**
 * Helper to deep walk objects.
 */

async function iterate(obj, cb) {
  for (var property in obj) {
    await cb(obj);
    if (obj.hasOwnProperty(property)) {
      var val = obj[property];
      if (typeof val == 'object') {
	await iterate(val, cb);
      }
    }
  }
}


/**
 * Cache to avoid round-trips to the server for files.
 */


function Cache() {
  this.fields = {};
};


Cache.prototype.set = function (key, val) {
  this.fields[key] = val;
};


Cache.prototype.has = function (key) {
  return this.fields.hasOwnProperty(key);
};


Cache.prototype.get = function (key) {
  return this.fields[key];
};


const _DOC_CACHE= new Cache();
const _HTTP_CACHE = new Cache();


/**
 * Custom YAML types.
 */


var DocYamlType = new jsyaml.Type('!g.doc', {
  kind: 'scalar',
  construct: function(path) {
    return Doc.get(path);
  },
  instanceOf: Doc
});


var StaticYamlType = new jsyaml.Type('!g.static', {
  kind: 'scalar',
  construct: function(path) {
    return Static.get(path);
  },
  instanceOf: Static
});


var schema = jsyaml.Schema.create([
  DocYamlType, 
  StaticYamlType
]);


/**
 * Static object.
 */


function Static(path) {
  this.path = path;
  this.url = path;
}


Static.get = function(path) {
  return new Static(path);
}


/**
 * URL object.
 */


function Url(path) {
  this.path = path;
};


Url.prototype.toString = function() {
  return this.path;
};


/**
 * Routes object.
 */


function Routes(path) {
  this.path = path;
  this.trie = new Trie();
  this.doc_ = Doc.get(path);
}


Routes.prototype.reverse = function(doc) {
};


Routes.prototype.match = function(path) {
  // Return the doc to render.
  let match = this.trie.match(path);
  if (!match.node) {
    throw Error('No pattern in /routes.yaml matches -> ' + path);
    return;
  }
  let data = match.node.data;

  if (data.doc) {
    return data.doc;
  } else if (data.collection) {
    // NOTE: So hacky. We should have methods to convert routes nicely.
    return Doc.get(data.collection + match.params['base'] + '.yaml');
  }
};


Routes.prototype.resolve = async function() {
  await this.doc_.resolve();
  this.doc_.fields['routes'].forEach(function(route) {
    // NOTE: I hacked trie.js to allow for this second argument to put
    // arbitrary data on the matched nodes.
    this.trie.define(route.pattern, route);
  }.bind(this));
}


/**
 * Pod object.
 */


function Pod() {
  this.routes = new Routes('/routes.yaml');
}


/**
 * Document object.
 */


function Doc(path) {
  this.path = path;
  this.fields = null;
  this.resolved = false;

  this.url = new Url(path);
}


Doc.get = function(path) {
  // Docs are a bit expensive with all the YAML fetching and parsing. Use a
  // global doc cache because once docs are resolved they don't change.
  if (_DOC_CACHE.has(path)) {
    return _DOC_CACHE.get(path);
  }
  let doc = new Doc(path);
  _DOC_CACHE.set(path, doc);
  return doc;
}


Doc.prototype.populate = function() {
  for (var property in this.fields) {
    // TODO: Handle builtins somehow.
    let cleanProperty = property.replace('$', '');
    this[cleanProperty] = this.fields[property];
  }
};


Doc.prototype.toString = function() {
  // Star to indicate unresolved fields, useful for debugging.
  if (this.resolved) {
    return '<Doc [path=' + this.path + ']>';
  } else {
    return '<Doc* [path=' + this.path + ']>';
  }
};


Doc.prototype.resolve = async function () {
  if (this.resolved) {
    return;
  }
  console.log('Resolving', this.path);
  await this._resolve();
  async function cb(obj) {
    if (obj.resolve) {
      await obj.resolve();
    }
  }
  await iterate(this.fields, cb);
};


Doc.prototype._resolve = async function() {
  if (_HTTP_CACHE.has(this.path)) {
    var resp = _HTTP_CACHE.get(this.path);
  } else {
    // NOTE: We want to abstract this out probably so we can use fs in the Node
    // env.
    var resp = await jQuery.get(this.path);
    _HTTP_CACHE.set(this.path, resp);
  }
  let fields = await jsyaml.load(resp, {schema: schema});
  this.fields = fields;
  this.populate();
  this.resolved = true;
};


Doc.prototype.getView = function() {
  let view = this.fields['$view'] || '/views/base.html';
  return view.replace('/views', 'views');
};


function gettext(content) {
  return content;
}


/**
 * Set up the nunchucks env.
 */


function setupNunjucks() {
  let env = nunjucks.configure('../', {
    autoescape: true,
    web: {
      async: true
    }
  });
  env.addFilter('resolve', async function(resolver, cb) {
    await resolver.resolve();
    cb(null, resolver);
  }, true);
  env.addFilter('localize', function(str) {
    return str;  // No-op.
  });
  env.addFilter('json', function(obj) {
    return JSON.stringify(obj);
  });
  return env;
}


async function main() {
  let startTime = performance.now();

  // Make a pod and resolve the routes from /routes.yaml.
  let pod = new Pod();
  await pod.routes.resolve();

  // Get the doc that corresponds to the URL path.
  let doc = pod.routes.match(window.location.pathname);
  await doc.resolve();

  let endTime = performance.now();
  console.log('Loaded: ' + Math.floor(endTime - startTime) + 'ms');

  // Use these params for all template envs.
  let params = {
    '_': gettext,
    'doc': doc,
    'g': {
      'doc': Doc.get,
      'static': Static.get
    }
  }

  // Render the doc and write the output to the browser document.
  startTime = performance.now();
  let env = setupNunjucks();
  let html = env.render(doc.getView(), params, function(err, res) {
    let endTime = performance.now();
    document.write(res);
    document.close();
    console.log('Rendered: ' + Math.floor(endTime - startTime) + 'ms');
  });
};
main();
