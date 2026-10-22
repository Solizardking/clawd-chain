// Load the explorer's classic scripts in a browser-like global.
// No Node module or require. Timers are stubbed so the process can exit.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUBLIC = path.join(__dirname, '..', 'explorer', 'public');

function defaultFetch() {
  return Promise.resolve({
    ok: true,
    json: async () => ({ result: null }),
    text: async () => '',
  });
}

function browserSandbox(opts = {}) {
  const elements = new Map();
  function makeEl(sel) {
    const key = String(sel);
    if (elements.has(key)) return elements.get(key);
    const el = {
      selector: key,
      id: key.replace(/^#/, ''),
      value: '',
      textContent: '',
      innerHTML: '',
      className: '',
      disabled: false,
      style: {},
      dataset: {},
      onclick: null,
      onsubmit: null,
      addEventListener(type, fn) { this['on' + type] = fn; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      closest() { return null; },
      getAttribute() { return null; },
      setAttribute() {},
      classList: { add() {}, remove() {}, toggle() {} },
    };
    elements.set(key, el);
    return el;
  }
  const pathname = opts.pathname || '/explorer';
  const location = { pathname, href: 'http://127.0.0.1' + pathname, search: '' };
  const history = {
    pushState(_state, _title, next) {
      location.pathname = next;
      location.href = 'http://127.0.0.1' + next;
    },
  };
  const fetchImpl = opts.fetch || defaultFetch;
  const document = {
    querySelector: sel => makeEl(sel),
    querySelectorAll: () => [],
    getElementById: id => makeEl('#' + id),
    addEventListener() {},
    createElement: () => makeEl('el'),
  };
  const window = {
    document,
    location,
    history,
    navigator: opts.navigator || {},
    fetch: (...args) => fetchImpl(...args),
    setInterval() { return 1; },
    setTimeout() { return 1; },
    clearInterval() {},
    clearTimeout() {},
    addEventListener() {},
    requestAnimationFrame() { return 1; },
    cancelAnimationFrame() {},
    console,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    performance: { now: () => Date.now() },
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1,
    onresize: null,
    onpopstate: null,
  };
  window.window = window;
  window.self = window;
  window.globalThis = window;
  vm.createContext(window);
  return { sandbox: window, window, document, location, history, elements };
}

function extractScripts(html) {
  const scripts = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html))) {
    const attrs = match[1] || '';
    const type = /type\s*=\s*["']([^"']+)["']/i.exec(attrs);
    const src = /src\s*=\s*["']([^"']+)["']/i.exec(attrs);
    scripts.push({
      type: type ? type[1] : '',
      src: src ? src[1] : null,
      defer: /\bdefer\b/i.test(attrs),
      code: match[2],
    });
  }
  return scripts;
}

function runPage(htmlPath, opts = {}) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const scripts = extractScripts(html);
  if (scripts.some(script => String(script.type).toLowerCase() === 'module')) {
    throw new Error('type=module script in ' + htmlPath);
  }
  const ctx = browserSandbox(opts);
  const ordered = [...scripts.filter(script => !script.defer), ...scripts.filter(script => script.defer)];
  for (const script of ordered) {
    let code = script.code;
    if (script.src) {
      const rel = script.src.replace(/^\//, '');
      if (rel.includes('..')) throw new Error('script path escapes public: ' + script.src);
      const fromPublic = path.join(PUBLIC, rel);
      const fromRoot = path.join(PUBLIC, '..', '..', rel);
      code = fs.readFileSync(fs.existsSync(fromPublic) ? fromPublic : fromRoot, 'utf8');
    }
    if (!String(code).trim()) continue;
    vm.runInContext(code, ctx.sandbox, { filename: script.src || htmlPath });
  }
  return { ...ctx, html, scripts, ordered };
}

module.exports = { PUBLIC, browserSandbox, extractScripts, runPage };

if (require.main === module) {
  try {
    for (const name of ['index.html', 'explorer.html', 'launchpad.html']) {
      const loaded = runPage(path.join(PUBLIC, name));
      if (loaded.scripts.some(script => String(script.type).toLowerCase() === 'module')) {
        throw new Error(name + ' has a module script');
      }
      console.log('PASS no throw ' + name + ' scripts ' + loaded.ordered.map(script => script.src || 'inline').join(','));
    }
    console.log('PASS browser scripts classic global');
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  }
}
