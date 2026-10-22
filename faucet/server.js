// clawd faucet: proof-of-work captcha, per-wallet and per-IP rolling 12h caps (CLAIM_WINDOW_HOURS).
const http = require('http'), crypto = require('crypto'), fs = require('fs');
const { sumRecent, remainingClawd } = require('./quota');
const { createFeed } = require('./feed');
const feed = createFeed({ size: +process.env.FEED_SIZE || 50 });
const PORT = +process.env.PORT || 8080;
const RPC = process.env.VALIDATOR_RPC || 'http://95.216.154.157:8080';
const FAUCET_KEY = process.env.FAUCET_KEY || '';
const SECRET = process.env.POW_SECRET || crypto.randomBytes(32).toString('hex');
const EXPLORER = process.env.EXPLORER_URL || 'https://clawdchain.trade';
// Defaults: 69 CLAWD per claim, 1 claim per wallet per rolling 12h window. Env can override.
const AMOUNT = +process.env.AIRDROP_SOL || 69;
const CLAIMS = +process.env.CLAIMS_PER_WINDOW || +process.env.CLAIMS_PER_DAY || 1;
const WINDOW_H = +process.env.CLAIM_WINDOW_HOURS || 12, WINDOW = WINDOW_H * 3_600_000;
const WALLET_CAP = AMOUNT * CLAIMS, IP_CAP = +process.env.IP_CAP_SOL || AMOUNT * 2;
const DAY = 86_400_000, BITS = +process.env.POW_BITS || 20;
const CHALLENGE_TTL = +process.env.CHALLENGE_TTL_MS || 600_000;
// Wallet the validator's built-in faucet pays from (ledger faucet-keypair.json).
const FAUCET_PUBKEY = process.env.FAUCET_PUBKEY || '3gGxCtJ8Npqp26rDFfpa4u4Px8eniF3oxjPS3RMDqYJJ';
const CONFIRM_MS = +process.env.CONFIRM_MS || 30_000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Lamports left in the faucet wallet, or null when the RPC gives no number.
async function faucetLamports() {
  const r = await rpc('getBalance', [FAUCET_PUBKEY, { commitment: 'confirmed' }]);
  const v = r && r.result && r.result.value;
  return typeof v === 'number' ? v : null;
}
// Wait for the airdrop to land. Returns null on success, or an error string
// when it failed on-chain or never confirmed. RPCs without status support pass.
async function confirmAirdrop(signature) {
  const end = Date.now() + CONFIRM_MS;
  while (Date.now() < end) {
    const r = await rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
    const list = r && r.result && r.result.value;
    if (!Array.isArray(list)) return null;
    const st = list[0];
    if (st && st.err) return 'airdrop failed on-chain: ' + JSON.stringify(st.err);
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return null;
    await sleep(500);
  }
  return 'airdrop not confirmed in time, try again';
}
const wallets = new Map(), ips = new Map(), used = new Set();
const page = fs.readFileSync(__dirname + '/index.html', 'utf8');
const powScript = fs.readFileSync(__dirname + '/pow.js');
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('hex').slice(0, 32);
const ipOf = r => (r.headers['x-forwarded-for'] || r.socket.remoteAddress || '').split(',')[0].trim();
const lz = buf => { let n = 0; for (const b of buf) { if (b === 0) { n += 8; continue; } n += Math.clz32(b) - 24; break; } return n; };
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};
const json = (res, code, o) => { res.writeHead(code, Object.assign({ 'content-type': 'application/json' }, CORS)); res.end(JSON.stringify(o)); };
const dropEvent = (list, event) => { const idx = list.indexOf(event); if (idx >= 0) list.splice(idx, 1); };
async function rpc(method, params) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json', 'x-faucet-key': FAUCET_KEY }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return r.json();
}
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, Object.assign({ 'content-type': 'text/html' }, CORS)); return res.end(page.replaceAll('{{AMOUNT}}', AMOUNT.toLocaleString('en-US')).replaceAll('{{BITS}}', BITS).replaceAll('{{CLAIMS}}', CLAIMS).replaceAll('{{WINDOW}}', WINDOW_H).replaceAll('{{IP_CAP}}', IP_CAP.toLocaleString('en-US')).replaceAll('{{EXPLORER}}', EXPLORER)); }
  if (req.method === 'GET' && url.pathname === '/pow.js') { res.writeHead(200, Object.assign({ 'content-type': 'text/javascript', 'cache-control': 'no-cache' }, CORS)); return res.end(powScript); }
  if (req.method === 'GET' && url.pathname === '/recent') return json(res, 200, { amount: AMOUNT, explorer: EXPLORER, items: feed.recent(url.searchParams.get('limit')) });
  if (req.method === 'GET' && url.pathname === '/stream') return feed.subscribe(req, res, CORS);
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
  if (req.method === 'GET' && url.pathname === '/balance') return faucetLamports().then(l => json(res, 200, { address: FAUCET_PUBKEY, clawd: l === null ? null : l / 1e9, claimsLeft: l === null ? null : Math.floor(l / 1e9 / AMOUNT) }), () => json(res, 502, { error: 'rpc error' }));
  if (req.method === 'GET' && url.pathname === '/challenge') { const c = `${Date.now()}.${crypto.randomBytes(8).toString('hex')}`; return json(res, 200, { challenge: `${c}.${sign(c)}`, bits: BITS }); }
  if (req.method === 'GET' && url.pathname === '/quota') {
    const address = url.searchParams.get('address') || '';
    const now = Date.now();
    return json(res, 200, remainingClawd({
      walletEvents: wallets.get(address) || [],
      ipEvents: ips.get(ipOf(req)) || [],
      now,
      day: WINDOW,
      amount: WALLET_CAP,
      ipCap: IP_CAP,
    }));
  }
  if (req.method === 'POST' && url.pathname === '/airdrop') {
    let body = ''; req.on('data', d => { body += d; if (body.length > 4096) req.destroy(); });
    req.on('end', async () => {
      try {
        const { address, challenge, nonce } = JSON.parse(body || '{}');
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address || '')) return json(res, 400, { error: 'invalid address' });
        const [ts, rnd, sig] = String(challenge || '').split('.');
        if (!sig || sign(`${ts}.${rnd}`) !== sig || Date.now() - +ts > CHALLENGE_TTL || used.has(challenge)) return json(res, 400, { error: 'invalid or expired challenge' });
        if (lz(crypto.createHash('sha256').update(`${challenge}:${nonce}`).digest()) < BITS) return json(res, 400, { error: 'proof of work failed' });
        const now = Date.now(), ip = ipOf(req), w = wallets.get(address) || [], i = ips.get(ip) || [];
        if (sumRecent(w, now, WINDOW) + AMOUNT > WALLET_CAP) return json(res, 429, { error: `wallet limit: ${CLAIMS} claim(s) of ${AMOUNT} CLAWD per ${WINDOW_H}h` });
        if (sumRecent(i, now, WINDOW) + AMOUNT > IP_CAP) return json(res, 429, { error: `IP limit: ${IP_CAP} CLAWD per ${WINDOW_H}h` });
        const walletEvent = { t: now, a: AMOUNT }, ipEvent = { t: now, a: AMOUNT };
        w.push(walletEvent); i.push(ipEvent); wallets.set(address, w); ips.set(ip, i);
        used.add(challenge);
        let released = false;
        const release = () => { if (released) return; released = true; dropEvent(w, walletEvent); dropEvent(i, ipEvent); };
        try {
          const left = await faucetLamports();
          if (left !== null && left < AMOUNT * 1e9 + 1e7) { release(); used.delete(challenge); return json(res, 503, { error: `faucet is empty (${Math.floor(left / 1e9)} CLAWD left), try again later` }); }
          const r = await rpc('requestAirdrop', [address, AMOUNT * 1e9]);
          if (r.error) { release(); return json(res, 502, { error: r.error.message }); }
          const failed = await confirmAirdrop(r.result);
          if (failed) { release(); return json(res, 502, { error: failed, signature: r.result }); }
          released = true;
          feed.push({ signature: r.result, to: address, amount: AMOUNT, t: Date.now() });
          json(res, 200, { signature: r.result, amount: AMOUNT });
        } catch (err) {
          release();
          if (!res.headersSent) json(res, 500, { error: 'faucet error' });
        }
      } catch (e) { if (!res.headersSent) json(res, 500, { error: 'faucet error' }); }
    });
    return;
  }
  json(res, 404, { error: 'not found' });
}).listen(PORT, '::', () => console.log('faucet on', PORT));
setInterval(() => { const now = Date.now(); for (const m of [wallets, ips]) for (const [k, v] of m) { const f = v.filter(e => now - e.t < DAY); f.length ? m.set(k, f) : m.delete(k); } if (used.size > 50000) used.clear(); }, 600_000);
