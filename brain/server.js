// Chain brain. Polls the local validator and remembers transactions, token
// movements, and supply snapshots in Supermemory. Search stays on BRAIN_PORT.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createMemory, scrub } = require('./memory');
const { createWatcher } = require('./watch');

function loadDotEnv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const k = t.slice(0, i).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || process.env[k] != null) continue;
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[k] = v;
  }
}

function loadState(file) {
  if (!file) return { cursor: null, indexed: 0, snapshots: 0, lastError: null, slot: 0 };
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && (j.cursor == null || typeof j.cursor === 'number')) {
      return { cursor: j.cursor ?? null, indexed: Number(j.indexed) || 0, snapshots: Number(j.snapshots) || 0, lastError: null, slot: Number(j.slot) || 0 };
    }
  } catch { /* first boot */ }
  return { cursor: null, indexed: 0, snapshots: 0, lastError: null, slot: 0 };
}

function saveState(file, state) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ cursor: state.cursor, indexed: state.indexed, snapshots: state.snapshots, slot: state.slot }));
    fs.renameSync(tmp, file);
  } catch { /* no volume in local runs */ }
}

function createBrainServer({ memory, state }) {
  const hits = new Map();
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://brain');
    const send = (code, obj) => {
      if (res.writableEnded) return;
      res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
      return res.end();
    }
    if (url.pathname === '/health' && req.method === 'GET') {
      return send(200, { ok: true, slot: state.slot, cursor: state.cursor, indexed: state.indexed, snapshots: state.snapshots, namespace: memory.namespace, lastError: state.lastError });
    }
    if (url.pathname === '/search' && req.method === 'POST') {
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const now = Date.now();
      let h = hits.get(ip);
      if (!h || now - h.t > 10_000) h = { t: now, n: 0 };
      h.n += 1;
      hits.set(ip, h);
      if (h.n > 30) return send(429, { error: 'slow down' });
      let body = '';
      try {
        body = await new Promise((resolve, reject) => {
          req.on('data', d => { body += d; if (body.length > 4000) reject(new Error('body too large')); });
          req.on('end', () => resolve(body));
          req.on('error', reject);
        });
        const parsed = JSON.parse(body || '{}');
        const result = await memory.search(parsed.query, { limit: parsed.limit });
        return send(200, result || {});
      } catch (err) {
        return send(400, { error: scrub(process.env.SUPERMEMORY_API_KEY, err.message || 'bad request') });
      }
    }
    send(404, { error: 'not found' });
  });
}

async function loop(watcher, state, stateFile) {
  for (;;) {
    let delay = 1500;
    try {
      const before = state.cursor;
      await watcher.tick();
      saveState(stateFile, state);
      if (state.cursor !== before) console.log(`brain cursor ${state.cursor} indexed ${state.indexed} snapshots ${state.snapshots}`);
      delay = state.cursor == null || state.cursor < state.slot ? 1000 : 2000;
    } catch (err) {
      state.lastError = scrub(process.env.SUPERMEMORY_API_KEY, err.message || 'tick failed');
      console.error('brain tick:', state.lastError);
      delay = 2000;
    }
    await new Promise(r => setTimeout(r, delay));
  }
}

function main() {
  loadDotEnv(path.join(__dirname, '..', '.env'));
  const memory = createMemory();
  if (!memory.configured()) {
    console.log('brain idle: SUPERMEMORY_API_KEY unset');
    return;
  }
  const rpc = process.env.BRAIN_RPC || 'http://127.0.0.1:8899';
  const stateFile = process.env.BRAIN_STATE || (fs.existsSync('/data') ? '/data/brain-state.json' : '');
  const state = loadState(stateFile);
  const watcher = createWatcher({
    rpc,
    memory,
    state,
    fromSlot: process.env.BRAIN_FROM == null || process.env.BRAIN_FROM === '' ? 0 : Number(process.env.BRAIN_FROM),
    window: Number(process.env.BRAIN_WINDOW || 8),
    pauseMs: Number(process.env.BRAIN_PAUSE_MS || 50),
    snapshotEvery: process.env.BRAIN_SNAPSHOT_EVERY == null || process.env.BRAIN_SNAPSHOT_EVERY === '' ? 100 : Number(process.env.BRAIN_SNAPSHOT_EVERY),
  });
  const port = Number(process.env.BRAIN_PORT || 8091);
  const server = createBrainServer({ memory, state });
  server.listen(port, '0.0.0.0', () => console.log(`brain listening on ${port} namespace ${memory.namespace}`));
  loop(watcher, state, stateFile);
}

module.exports = { createBrainServer, loadState, saveState, loadDotEnv };

if (require.main === module) main();
