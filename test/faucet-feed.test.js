const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { createFeed } = require('../faucet/feed');
const page = require('../explorer/public/faucet-feed.js');

const ROOT = path.join(__dirname, '..');
const SIG = '5'.repeat(88);
const TO = '7'.repeat(44);

function port() {
  return new Promise(resolve => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function start(file, env) {
  const child = spawn(process.execPath, [file], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    child.stdout.on('data', d => { if (/ on /.test(String(d))) resolve(child); });
    child.on('exit', code => reject(new Error(file + ' exited ' + code)));
  });
}
function pow(challenge, bits) {
  for (let n = 0; ; n++) {
    const h = crypto.createHash('sha256').update(`${challenge}:${n}`).digest();
    let z = 0; for (const b of h) { if (b === 0) { z += 8; continue; } z += Math.clz32(b) - 24; break; }
    if (z >= bits) return n;
  }
}

test('feed keeps the newest airdrops first, caps the buffer, and fans out SSE frames', () => {
  const feed = createFeed({ size: 3 });
  for (let i = 0; i < 5; i++) feed.push({ signature: SIG.slice(0, 87) + i, to: TO, amount: 5, t: i });
  assert.equal(feed.recent(10).length, 3);
  assert.equal(feed.recent(10)[0].t, 4);
  const frames = [];
  const listeners = {};
  const res = { writeHead: () => {}, write: f => frames.push(f) };
  feed.subscribe({ on: (e, f) => { listeners[e] = f; } }, res);
  assert.match(frames[0], /event: hello/);
  feed.push({ signature: SIG, to: TO, amount: 5 });
  assert.match(frames.at(-1), /^event: airdrop\ndata: .*"amount":5/);
  assert.equal(feed.clients(), 1);
  listeners.close();
  assert.equal(feed.clients(), 0);
});

test('page rows link the signature and recipient and refuse non-base58 input', () => {
  const html = page.row({ signature: SIG, to: TO, amount: 5, t: Date.now() - 65000 }, true);
  assert.match(html, new RegExp(`href="/tx/${SIG}"`));
  assert.match(html, new RegExp(`href="/address/${TO}"`));
  assert.match(html, /ff-new/);
  assert.match(html, /\+5 CLAWD/);
  assert.match(html, /1m ago/);
  assert.equal(page.row({ signature: '<img src=x>', to: TO, amount: 5, t: 0 }), '');
  assert.equal(page.short(TO), '7777…7777');
});

test('a faucet airdrop shows up on /recent, the faucet stream, and the explorer relay', { timeout: 30000 }, async () => {
  const rpcPort = await port();
  const rpc = http.createServer((req, res) => { let b = ''; req.on('data', d => { b += d; }); req.on('end', () => { const m = JSON.parse(b); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: m.method === 'requestAirdrop' ? SIG : 1 })); }); }).listen(rpcPort, '127.0.0.1');
  const fPort = await port(), ePort = await port();
  const faucet = await start('faucet/server.js', { PORT: String(fPort), VALIDATOR_RPC: `http://127.0.0.1:${rpcPort}`, POW_BITS: '4', POW_SECRET: 'test-secret' });
  const explorer = await start('explorer/server.js', { PORT: String(ePort), VALIDATOR_RPC: `http://127.0.0.1:${rpcPort}`, FAUCET_INTERNAL: `http://127.0.0.1:${fPort}` });
  const F = `http://127.0.0.1:${fPort}`, E = `http://127.0.0.1:${ePort}`;
  try {
    assert.deepEqual((await (await fetch(F + '/recent')).json()).items, []);
    const frames = [];
    const sse = http.get(E + '/api/faucet/stream', r => { assert.equal(r.headers['content-type'], 'text/event-stream'); r.on('data', d => frames.push(String(d))); });
    await new Promise(r => setTimeout(r, 300));
    const { challenge } = await (await fetch(F + '/challenge')).json();
    const drop = await fetch(F + '/airdrop', { method: 'POST', body: JSON.stringify({ address: TO, challenge, nonce: pow(challenge, 4) }) });
    assert.equal(drop.status, 200);
    const recent = (await (await fetch(F + '/recent')).json()).items;
    assert.equal(recent[0].signature, SIG);
    assert.equal(recent[0].to, TO);
    assert.equal(recent[0].amount, 5);
    const relayed = (await (await fetch(E + '/api/faucet/recent')).json()).items;
    assert.equal(relayed[0].signature, SIG);
    await new Promise(r => setTimeout(r, 300));
    assert.match(frames.join(''), /event: airdrop/);
    sse.destroy();
    const home = await (await fetch(E + '/')).text();
    assert.match(home, /id="faucet-feed"/);
    assert.match(home, /\/faucet-feed\.js/);
  } finally {
    faucet.kill(); explorer.kill(); rpc.close();
  }
});
