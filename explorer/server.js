// clawd explorer + landing site. Serves static pages and a cached, read-only RPC relay.
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = +process.env.PORT || 8080;
const RPC = process.env.VALIDATOR_RPC || 'https://clawd-validator-production.up.railway.app';
const ALLOW = new Set(['getSlot','getEpochInfo','getRecentPerformanceSamples','getBlock','getBlocks','getBlockTime','getTransaction',
  'getAccountInfo','getBalance','getSignaturesForAddress','getSupply','getVersion','getBlockHeight','getTransactionCount','getHealth','getGenesisHash','getClusterNodes','getSignatureStatuses']);
const TTL = { getSlot: 1500, getEpochInfo: 2000, getRecentPerformanceSamples: 10000, getSupply: 30000, getVersion: 60000, getTransactionCount: 3000,
  getBlockHeight: 2000, getHealth: 3000, getGenesisHash: 600000, getClusterNodes: 60000, getBlock: 600000, getTransaction: 600000, getBlocks: 2000 };
const cache = new Map(), inflight = new Map(), hits = new Map();
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };
async function call(method, params) {
  const key = method + JSON.stringify(params || []);
  const c = cache.get(key); if (c && Date.now() < c.exp) return c.v;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || [] }) });
    const j = await r.json();
    let ttl = TTL[method] ?? 4000;
    if ((method === 'getTransaction' || method === 'getBlock') && !j.result) ttl = 2000;
    if (!j.error) cache.set(key, { v: j, exp: Date.now() + ttl });
    return j;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p); return p;
}
setInterval(() => { const n = Date.now(); for (const [k, v] of cache) if (n > v.exp) cache.delete(k); hits.clear(); if (cache.size > 5000) cache.clear(); }, 10000);
const ipOf = r => (r.headers['x-forwarded-for'] || r.socket.remoteAddress || '').split(',')[0].trim();
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }
  if (url.pathname === '/api/rpc' && req.method === 'POST') {
    const ip = ipOf(req), n = (hits.get(ip) || 0) + 1; hits.set(ip, n);
    const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (n > 60) return send(429, { error: { message: 'slow down' } });
    let b = ''; req.on('data', d => { b += d; if (b.length > 8192) req.destroy(); });
    req.on('end', async () => {
      try { const { method, params } = JSON.parse(b); if (!ALLOW.has(method)) return send(403, { error: { message: 'method not allowed' } });
        send(200, await call(method, params)); } catch (e) { send(502, { error: { message: 'rpc unavailable' } }); }
    });
    return;
  }
  let p = url.pathname;
  if (p === '/' ) p = '/index.html';
  else if (/^\/(explorer|tx|address|block)(\/|$)/.test(p)) p = '/explorer.html';
  const f = path.join(__dirname, 'public', path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'public, max-age=60' }); res.end(d); });
}).listen(PORT, '::', () => console.log('explorer on', PORT));
