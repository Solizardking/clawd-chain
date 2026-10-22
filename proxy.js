// Public RPC gateway: rate limits, blocks heavy methods, proxies HTTP->8899 and WS->8900.
// Serves getPriorityFeeEstimate locally from the validator's getRecentPrioritizationFees.
// Serves getShieldLimits locally. It does not read the vault from the validator.
const http = require('http'), net = require('net');
const { extractPrioritizationFees, priorityFeeResult } = require('./lib/priority-fee');
const { shieldLimits } = require('./lib/shield-limits');
const PORT = +process.env.PORT || 8080, FAUCET_KEY = process.env.FAUCET_KEY || '';
const UPSTREAM = process.env.UPSTREAM_HTTP || 'http://127.0.0.1:8899';
const BLOCKED = new Set(['getProgramAccounts', 'getLargestAccounts', 'requestAirdrop']);
const RATE = +process.env.RPC_RATE || 40, WINDOW = 10_000, MAX_BATCH = 10, MAX_WS = 5;
const hits = new Map(), wsCount = new Map();
const ipOf = r => (r.headers['x-forwarded-for'] || r.socket.remoteAddress || '').split(',')[0].trim();
const privileged = r => FAUCET_KEY && r.headers['x-faucet-key'] === FAUCET_KEY;
function limited(ip, cost) {
  const now = Date.now(); let h = hits.get(ip);
  if (!h || now - h.t > WINDOW) { h = { t: now, n: 0 }; hits.set(ip, h); }
  h.n += cost; return h.n > RATE;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.t > WINDOW) hits.delete(k); }, 60_000);
const err = (res, code, msg, id = null) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000 - code, message: msg } })); };
function upstreamHost() {
  const u = new URL(UPSTREAM);
  return { host: u.hostname, port: Number(u.port || 80) };
}
function feeSpec(call) {
  return callSpec(call);
}
async function recentFees(spec) {
  const hasKeys = Object.prototype.hasOwnProperty.call(spec, 'accountKeys');
  const payload = { jsonrpc: '2.0', id: 1, method: 'getRecentPrioritizationFees', params: hasKeys ? [spec.accountKeys] : [] };
  const r = await fetch(UPSTREAM, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  if (!r.ok) throw new Error('validator unavailable');
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'validator unavailable');
  return j.result;
}
function callSpec(call) {
  const p = call && call.params;
  if (Array.isArray(p)) return p[0] && typeof p[0] === 'object' ? p[0] : {};
  if (p && typeof p === 'object') return p;
  return {};
}
function serveShield(call) {
  const id = call && call.id != null ? call.id : null;
  const spec = callSpec(call);
  try {
    const result = shieldLimits(spec);
    return { jsonrpc: '2.0', id, result };
  } catch {
    return { jsonrpc: '2.0', id, error: { code: -32602, message: 'vaultLamports must be an integer' } };
  }
}
async function serveFee(call) {
  const id = call && call.id != null ? call.id : null;
  try {
    const spec = feeSpec(call);
    const include = !!(spec.options && spec.options.includeAllPriorityFeeLevels === true);
    const result = priorityFeeResult(extractPrioritizationFees(await recentFees(spec)), include);
    return { jsonrpc: '2.0', id, result };
  } catch (e) {
    return { jsonrpc: '2.0', id, error: { code: -32002, message: e.message || 'validator unavailable' } };
  }
}
function proxyRaw(body) {
  return new Promise((resolve, reject) => {
    const up = http.request({ ...upstreamHost(), method: 'POST', path: '/', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, u => {
      const chunks = [];
      u.on('data', c => chunks.push(c));
      u.on('end', () => resolve({ status: u.statusCode, body: Buffer.concat(chunks) }));
    });
    up.on('error', reject);
    up.end(body);
  });
}
function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
}
const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,solana-client,x-faucet-key', 'access-control-allow-methods': 'POST,GET,OPTIONS' }); return res.end(); }
  if (req.method === 'GET') {
    const path = (req.url || '/').split('?')[0];
    if (path === '/status') {
      return sendJson(res, 200, {
        blockedMethods: [...BLOCKED],
        ratePerIp: RATE,
        windowMs: WINDOW,
        servedMethods: ['getPriorityFeeEstimate', 'getShieldLimits'],
      });
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('clawd chain RPC. POST JSON-RPC here; wss:// for subscriptions.\n');
  }
  let body = '', size = 0;
  req.on('data', c => { size += c.length; if (size > 65536) { err(res, 413, 'body too large'); req.destroy(); } else body += c; });
  req.on('end', () => {
    if (res.writableEnded) return;
    handle(req, res, body).catch(() => { if (!res.writableEnded) err(res, 502, 'validator unavailable'); });
  });
});
async function handle(req, res, body) {
  let p; try { p = JSON.parse(body); } catch { return err(res, 400, 'invalid json'); }
  const calls = Array.isArray(p) ? p : [p];
  const priv = privileged(req);
  if (!priv) {
    if (calls.length > MAX_BATCH) return err(res, 400, `batch max ${MAX_BATCH}`);
    const bad = calls.find(c => BLOCKED.has(c && c.method));
    if (bad) return err(res, 403, `method ${bad.method} disabled on public RPC`, bad.id ?? null);
    if (limited(ipOf(req), calls.length)) return err(res, 429, 'rate limited', calls[0]?.id ?? null);
  }
  if (calls.some(c => c && (c.method === 'getPriorityFeeEstimate' || c.method === 'getShieldLimits'))) {
    const results = [];
    for (const c of calls) {
      if (c && c.method === 'getPriorityFeeEstimate') results.push(await serveFee(c));
      else if (c && c.method === 'getShieldLimits') results.push(serveShield(c));
      else {
        const one = await proxyRaw(JSON.stringify(c));
        results.push(JSON.parse(one.body.toString() || 'null'));
      }
    }
    return sendJson(res, 200, Array.isArray(p) ? results : results[0]);
  }
  try {
    const up = await proxyRaw(body);
    res.writeHead(up.status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(up.body);
  } catch { err(res, 502, 'validator unavailable'); }
}
server.on('upgrade', (req, sock, head) => {
  const ip = ipOf(req), n = wsCount.get(ip) || 0;
  if (n >= MAX_WS) { sock.end('HTTP/1.1 429 Too Many Requests\r\n\r\n'); return; }
  wsCount.set(ip, n + 1);
  const done = () => { const c = (wsCount.get(ip) || 1) - 1; c ? wsCount.set(ip, c) : wsCount.delete(ip); };
  const wsPort = +(process.env.UPSTREAM_WS_PORT || 8900);
  const up = net.connect(wsPort, upstreamHost().host, () => {
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    up.write(raw + '\r\n'); if (head?.length) up.write(head); sock.pipe(up).pipe(sock);
  });
  let closed = false; const close = () => { if (!closed) { closed = true; done(); } sock.destroy(); up.destroy(); };
  up.on('error', close); sock.on('error', close); up.on('close', close); sock.on('close', close);
});
server.listen(PORT, '::', () => console.log('rpc gateway on', PORT));
