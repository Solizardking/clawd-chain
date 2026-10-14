// Public RPC gateway: rate limits, blocks heavy methods, proxies HTTP->8899 and WS->8900.
const http = require('http'), net = require('net');
const PORT = +process.env.PORT || 8080, FAUCET_KEY = process.env.FAUCET_KEY || '';
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
const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,solana-client', 'access-control-allow-methods': 'POST,GET,OPTIONS' }); return res.end(); }
  if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('clawd chain RPC. POST JSON-RPC here; wss:// for subscriptions.\n'); }
  let body = '', size = 0;
  req.on('data', c => { size += c.length; if (size > 65536) { err(res, 413, 'body too large'); req.destroy(); } else body += c; });
  req.on('end', () => {
    if (res.writableEnded) return;
    let p; try { p = JSON.parse(body); } catch { return err(res, 400, 'invalid json'); }
    const calls = Array.isArray(p) ? p : [p];
    const priv = privileged(req);
    if (!priv) {
      if (calls.length > MAX_BATCH) return err(res, 400, `batch max ${MAX_BATCH}`);
      const bad = calls.find(c => BLOCKED.has(c && c.method));
      if (bad) return err(res, 403, `method ${bad.method} disabled on public RPC`, bad.id ?? null);
      if (limited(ipOf(req), calls.length)) return err(res, 429, 'rate limited', calls[0]?.id ?? null);
    }
    const up = http.request({ host: '127.0.0.1', port: 8899, method: 'POST', path: '/', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, u => {
      res.writeHead(u.statusCode, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); u.pipe(res);
    });
    up.on('error', () => err(res, 502, 'validator unavailable')); up.end(body);
  });
});
server.on('upgrade', (req, sock, head) => {
  const ip = ipOf(req), n = wsCount.get(ip) || 0;
  if (n >= MAX_WS) { sock.end('HTTP/1.1 429 Too Many Requests\r\n\r\n'); return; }
  wsCount.set(ip, n + 1);
  const done = () => { const c = (wsCount.get(ip) || 1) - 1; c ? wsCount.set(ip, c) : wsCount.delete(ip); };
  const up = net.connect(8900, '127.0.0.1', () => {
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    up.write(raw + '\r\n'); if (head?.length) up.write(head); sock.pipe(up).pipe(sock);
  });
  let closed = false; const close = () => { if (!closed) { closed = true; done(); } sock.destroy(); up.destroy(); };
  up.on('error', close); sock.on('error', close); up.on('close', close); sock.on('close', close);
});
server.listen(PORT, '::', () => console.log('rpc gateway on', PORT));
