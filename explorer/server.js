// clawd explorer + landing site. Serves static pages and a cached, read-only RPC relay.
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = +process.env.PORT || 8080;
const RPC = process.env.VALIDATOR_RPC || 'http://95.216.154.157:8080';
const MINT_DIR = process.env.MINT_DIR || path.join(__dirname, '..', 'mint');
const CHAIN_DIR = process.env.CHAIN_DIR || path.join(__dirname, '..', 'chain');
const ALLOW = new Set(['getSlot','getEpochInfo','getRecentPerformanceSamples','getBlock','getBlocks','getBlockTime','getTransaction',
  'getAccountInfo','getBalance','getSignaturesForAddress','getSupply','getVersion','getBlockHeight','getTransactionCount','getHealth','getGenesisHash','getClusterNodes','getSignatureStatuses','getTokenAccountsByOwner','getLatestBlockhash','getVoteAccounts']);
const TTL = { getSlot: 1500, getEpochInfo: 2000, getRecentPerformanceSamples: 10000, getSupply: 30000, getVersion: 60000, getTransactionCount: 3000,
  getBlockHeight: 2000, getHealth: 3000, getGenesisHash: 600000, getClusterNodes: 60000, getBlock: 600000, getTransaction: 600000, getBlocks: 2000 };
const MCP_MANIFEST = { name: 'clawd-chain', description: 'Read-only tools for the clawd SVM chain: Core NFTs, fungible tokens, agents, and x402 payments. Programs: Core CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d, Agent Identity 1DREGFgysWYxLnRnKQnwrxnJQeSMk2HmGaC6whw2B2p, Agent Tools TLREGni9ZEyGC3vnPZtqUh95xQ8oPqJSvNjvB7FGK8S, Genesis GNS1S5J5AspKXgpjz6SvKL66kPaKWAhaGRhCqPRxii2B, Token Metadata metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s, Token TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA, Token-2022 TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb.', transport: { type: 'streamable-http', url: 'https://mcp.clawdchain.trade/mcp' }, endpoints: { mcp: 'https://mcp.clawdchain.trade/mcp' },
  tools: ['get_slot','network_stats','get_balance','get_account','get_transaction','get_block','recent_blocks','search','faucet_info','get_nft','get_token','get_agent','payment_info'], docs: 'https://api.clawdchain.trade', llms: 'https://clawdchain.trade/llms.txt' };
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
const FAUCET_INTERNAL = process.env.FAUCET_INTERNAL || 'https://faucet.clawdchain.trade';
let faucetRecent = { exp: 0, body: null };
async function faucetFeed() {
  if (faucetRecent.body && Date.now() < faucetRecent.exp) return faucetRecent.body;
  const r = await fetch(FAUCET_INTERNAL + '/recent?limit=20', { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error('faucet ' + r.status);
  faucetRecent = { exp: Date.now() + 2000, body: await r.text() };
  return faucetRecent.body;
}
function faucetStream(req, res) {
  const lib = FAUCET_INTERNAL.startsWith('https:') ? require('https') : http;
  const up = lib.get(FAUCET_INTERNAL + '/stream', { headers: { accept: 'text/event-stream' } }, u => {
    res.writeHead(u.statusCode === 200 ? 200 : 502, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' });
    u.pipe(res);
  });
  up.on('error', () => { if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain' }); } res.end(); });
  req.on('close', () => up.destroy());
}
const ipOf = r => (r.headers['x-forwarded-for'] || r.socket.remoteAddress || '').split(',')[0].trim();
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }
  if (url.pathname === '/api/faucet/recent' && req.method === 'GET') {
    faucetFeed().then(b => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' }); res.end(b); },
      () => { res.writeHead(502, { 'content-type': 'application/json' }); res.end('{"items":[],"error":"faucet unavailable"}'); });
    return;
  }
  if (url.pathname === '/api/faucet/stream' && req.method === 'GET') return faucetStream(req, res);
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
  if (url.pathname === '/.well-known/mcp.json' || url.pathname === '/.well-known/mcp' || url.pathname === '/mcp.json') { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); return res.end(JSON.stringify(MCP_MANIFEST, null, 2)); }
  const sendFile = (file, type) => fs.readFile(file, (err, buf) => {
    if (err || !buf || !buf.length) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
    res.end(buf);
  });
  if (url.pathname === '/mint' || url.pathname === '/mint/' || url.pathname === '/mint/index.html') return sendFile(path.join(MINT_DIR, 'index.html'), 'text/html; charset=utf-8');
  if (url.pathname === '/mint/mint.js') return sendFile(path.join(MINT_DIR, 'mint.js'), 'text/javascript');
  if (url.pathname === '/chain/public-mint.js') return sendFile(path.join(CHAIN_DIR, 'public-mint.js'), 'text/javascript');
  if (url.pathname === '/chain/market.js') return sendFile(path.join(CHAIN_DIR, 'market.js'), 'text/javascript');
  const ext = url.pathname.match(/^\/extension\/([A-Za-z0-9._-]+)$/);
  if (ext) {
    const allow = new Set(['pow.js', 'names.js', 'wallet.js', 'popup.js']);
    if (!allow.has(ext[1])) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    const ef = path.join(__dirname, '..', 'extension', ext[1]);
    return fs.readFile(ef, (err, buf) => {
      if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
      res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-cache' });
      res.end(buf);
    });
  }
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  const launchSite = host === 'launch.clawdchain.trade' || process.env.SITE === 'launch';
  let p = url.pathname;
  if (p === '/' || (launchSite && p === '/index.html')) p = launchSite ? '/launchpad.html' : '/index.html';
  else if (p === '/readme' || p === '/readme/' || p === '/wallet' || p === '/wallet/') p = '/readme.html';
  else if (p === '/launchpad' || p === '/launchpad/') p = '/launchpad.html';
  else if (p === '/alpenglow' || p === '/alpenglow/') p = '/alpenglow.html';
  else if (p === '/ore' || p === '/ore/') p = '/ore.html';
  else if (/^\/(explorer|tx|address|block)(\/|$)/.test(p)) p = '/explorer.html';
  const f = path.join(__dirname, 'public', path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'public, max-age=60' }); res.end(d); });
}).listen(PORT, '::', () => console.log('explorer on', PORT));
