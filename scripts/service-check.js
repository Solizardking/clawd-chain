// Launch the real gateway, faucet, and explorer against a fake validator.
// Expected fee percentiles, quota totals, and labels are asserted as literals.
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const WALLET = '1'.repeat(32);
const IP_A = '198.51.100.10';
const IP_B = '203.0.113.99';
const FEE_LEVELS = { min: 1, low: 3, medium: 5, high: 7, veryHigh: 9, unsafeMax: 10 };
const FEE_ROWS = [10, 1, 9, 2, 8, 3, 7, 4, 6, 5].map((prioritizationFee, i) => ({
  slot: i + 1,
  prioritizationFee,
}));

const children = new Set();
process.on('exit', () => {
  for (const child of children) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
});

function leadingZeros(buf) {
  let n = 0;
  for (const b of buf) {
    if (b === 0) { n += 8; continue; }
    n += Math.clz32(b) - 24;
    break;
  }
  return n;
}

function solvePow(challenge, bits) {
  for (let nonce = 0; nonce < 2_000_000; nonce++) {
    const hash = crypto.createHash('sha256').update(`${challenge}:${nonce}`).digest();
    if (leadingZeros(hash) >= bits) return nonce;
  }
  throw new Error('no proof of work nonce');
}

function failPow(challenge, bits) {
  for (let nonce = 0; nonce < 2_000_000; nonce++) {
    const hash = crypto.createHash('sha256').update(`${challenge}:${nonce}`).digest();
    if (leadingZeros(hash) < bits) return nonce;
  }
  throw new Error('no failing nonce');
}

function eachCall(seen) {
  const out = [];
  for (const item of seen) {
    const list = Array.isArray(item) ? item : [item];
    for (const call of list) {
      if (call && typeof call === 'object' && call.method) out.push(call);
    }
  }
  return out;
}

function countMethod(seen, method) {
  return eachCall(seen).filter(call => call.method === method).length;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function startFake(respond) {
  let current = respond;
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      let parsed = null;
      const raw = Buffer.concat(chunks).toString('utf8');
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = { raw }; }
      seen.push(parsed);
      let reply;
      try { reply = current(parsed, seen); }
      catch (err) { reply = { jsonrpc: '2.0', id: null, error: { message: err.message } }; }
      if (!res.writableEnded) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply));
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        seen,
        setHandler(fn) { current = fn; },
        close() {
          return new Promise(done => {
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
            server.close(() => done());
          });
        },
      });
    });
  });
}

function primaryRespond(body) {
  if (Array.isArray(body)) return body.map(primaryRespond);
  const id = body && Object.prototype.hasOwnProperty.call(body, 'id') ? body.id : null;
  const method = body && body.method;
  if (method === 'getRecentPrioritizationFees') return { jsonrpc: '2.0', id, result: FEE_ROWS };
  if (method === 'requestAirdrop') return { jsonrpc: '2.0', id, result: 'airdropSigPrimary' };
  if (method === 'getTokenAccountsByOwner') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        value: [{
          pubkey: 'TokAcc111',
          account: {
            data: {
              parsed: {
                info: { mint: 'MintZ', tokenAmount: { amount: '42', decimals: 6 } },
              },
            },
          },
        }],
      },
    };
  }
  if (method === 'getSlot') return { jsonrpc: '2.0', id, result: 12345 };
  return { jsonrpc: '2.0', id, result: { ok: true, method } };
}

function killChild(child) {
  if (!child || child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve();
    }, 1500);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { child.kill('SIGTERM'); } catch { clearTimeout(timer); resolve(); }
  });
}

async function waitForHttp(url, timeoutMs) {
  const started = Date.now();
  let last = 'no response';
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.status < 500) {
        await response.arrayBuffer().catch(() => {});
        return;
      }
      last = 'status ' + response.status;
    } catch (err) {
      last = err.cause && err.cause.code ? err.cause.code : err.message;
    }
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('timed out waiting for ' + url + ' (' + last + ')');
}

async function startNode(rel, env, readyPath = '/') {
  const child = spawn(process.execPath, [path.join(ROOT, rel)], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.once('exit', () => children.delete(child));
  const base = `http://127.0.0.1:${env.PORT}`;
  try {
    await waitForHttp(base + readyPath, 8000);
  } catch (err) {
    await killChild(child);
    throw new Error(rel + ' failed on ' + env.PORT + ': ' + err.message + '\n' + output);
  }
  return {
    base,
    child,
    output: () => output,
    close: () => killChild(child),
  };
}

async function req(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  const init = { method: options.method || 'GET', headers };
  if (options.body !== undefined) {
    headers['content-type'] = headers['content-type'] || 'application/json';
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(url, init);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, headers: response.headers, text, json };
}

async function runPrimaryChecks() {
  const fake = await startFake(primaryRespond);
  const gatewayPort = String(await freePort());
  const faucetPort = String(await freePort());
  const explorerPort = String(await freePort());
  const gateway = await startNode('proxy.js', {
    PORT: gatewayPort,
    UPSTREAM_HTTP: fake.url,
    FAUCET_KEY: 'faucet-key',
    RPC_RATE: '40',
  }, '/');
  const faucet = await startNode('faucet/server.js', {
    PORT: faucetPort,
    VALIDATOR_RPC: fake.url,
    FAUCET_KEY: 'faucet-key',
    POW_SECRET: 'test-secret',
    POW_BITS: '8',
    AIRDROP_SOL: '5',
    IP_CAP_SOL: '10',
  }, '/health');
  const explorer = await startNode('explorer/server.js', {
    PORT: explorerPort,
    VALIDATOR_RPC: fake.url,
  }, '/health');
  try {
    const home = await fetch(gateway.base + '/');
    const homeText = await home.text();
    assert.equal(home.status, 200);
    assert.equal(home.headers.get('content-type'), 'text/plain');
    assert.equal(homeText, 'clawd chain RPC. POST JSON-RPC here; wss:// for subscriptions.\n');

    const status = await req(gateway.base + '/status');
    assert.equal(status.status, 200);
    assert.deepEqual(status.json.blockedMethods, ['getProgramAccounts', 'getLargestAccounts', 'requestAirdrop']);
    assert.equal(status.json.ratePerIp, 40);
    assert.equal(status.json.servedMethods.includes('getPriorityFeeEstimate'), true);

    const fee = await req(gateway.base + '/', {
      method: 'POST',
      body: {
        jsonrpc: '2.0',
        id: 'fee-1',
        method: 'getPriorityFeeEstimate',
        params: [{
          accountKeys: ['AcctKey111', 'AcctKey222'],
          options: {
            includeAllPriorityFeeLevels: true,
            lookbackSlots: 9,
            priorityLevel: 'High',
            recommended: true,
          },
        }],
      },
    });
    assert.equal(fee.status, 200);
    assert.equal(fee.json.id, 'fee-1');
    assert.equal(fee.json.result.priorityFeeEstimate, 5);
    assert.deepEqual(fee.json.result.priorityFeeLevels, FEE_LEVELS);
    const upstreamFee = eachCall(fake.seen).find(call => call.method === 'getRecentPrioritizationFees');
    assert.ok(upstreamFee, 'validator was not asked for recent fees');
    assert.deepEqual(upstreamFee.params, [['AcctKey111', 'AcctKey222']]);
    assert.equal(JSON.stringify(upstreamFee).includes('lookbackSlots'), false);
    assert.equal(countMethod(fake.seen, 'getPriorityFeeEstimate'), 0);

    const blocked = await req(gateway.base + '/', {
      method: 'POST',
      body: { jsonrpc: '2.0', id: 3, method: 'getProgramAccounts', params: ['11111111111111111111111111111111'] },
    });
    assert.equal(blocked.status, 403);
    assert.match(blocked.json.error.message, /getProgramAccounts/);
    assert.equal(countMethod(fake.seen, 'getProgramAccounts'), 0);

    const seenBeforeQuota = fake.seen.length;
    const quotaBefore = await req(faucet.base + '/quota?address=' + WALLET, {
      headers: { 'x-forwarded-for': IP_A },
    });
    assert.equal(quotaBefore.status, 200);
    assert.equal(quotaBefore.json.walletRemaining, 5);
    assert.equal(quotaBefore.json.ipRemaining, 10);
    assert.equal(fake.seen.length, seenBeforeQuota);
    assert.equal(countMethod(fake.seen, 'requestAirdrop'), 0);

    const challenge = await req(faucet.base + '/challenge');
    assert.equal(challenge.status, 200);
    assert.equal(challenge.json.bits, 8);
    const nonce = solvePow(challenge.json.challenge, challenge.json.bits);
    const drop = await req(faucet.base + '/airdrop', {
      method: 'POST',
      headers: { 'x-forwarded-for': IP_A },
      body: { address: WALLET, challenge: challenge.json.challenge, nonce },
    });
    assert.equal(drop.status, 200, drop.text);
    assert.equal(drop.json.signature, 'airdropSigPrimary');
    assert.equal(drop.json.amount, 5);
    const airdropCall = eachCall(fake.seen).find(call => call.method === 'requestAirdrop');
    assert.deepEqual(airdropCall.params, [WALLET, 5000000000]);

    const airdropsAfter = countMethod(fake.seen, 'requestAirdrop');
    const quotaAfter = await req(faucet.base + '/quota?address=' + WALLET, {
      headers: { 'x-forwarded-for': IP_A },
    });
    assert.equal(quotaAfter.json.walletRemaining, 0);
    assert.equal(quotaAfter.json.ipRemaining, 5);
    const quotaOther = await req(faucet.base + '/quota?address=' + WALLET, {
      headers: { 'x-forwarded-for': IP_B },
    });
    assert.equal(quotaOther.json.walletRemaining, 0);
    assert.equal(quotaOther.json.ipRemaining, 10);
    assert.equal(countMethod(fake.seen, 'requestAirdrop'), airdropsAfter);

    const tokens = await req(explorer.base + '/api/rpc', {
      method: 'POST',
      body: {
        method: 'getTokenAccountsByOwner',
        params: [WALLET, { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5v' }, { encoding: 'jsonParsed' }],
      },
    });
    assert.equal(tokens.status, 200, tokens.text);
    const info = tokens.json.result.value[0].account.data.parsed.info;
    assert.equal(info.mint, 'MintZ');
    assert.equal(info.tokenAmount.amount, '42');
    const denied = await req(explorer.base + '/api/rpc', {
      method: 'POST',
      body: { method: 'getProgramAccounts', params: [WALLET] },
    });
    assert.equal(denied.status, 403);
    assert.equal(countMethod(fake.seen, 'getProgramAccounts'), 0);

    const faucetPage = await (await fetch(faucet.base + '/')).text();
    assert.match(faucetPage, /\/quota\?address=/);
    assert.match(faucetPage, /walletRemaining/);
    assert.match(faucetPage, /remaining wallet allowance/);
    assert.match(faucetPage, /\/challenge/);
    assert.match(faucetPage, /\/airdrop/);
    assert.match(faucetPage, /\.box:before\{[^}]*pointer-events:none/);
    assert.match(faucetPage, /canvas#bg,canvas#fx\{[^}]*pointer-events:none/);
    assert.match(faucetPage, /src="\/pow\.js"/);
    assert.match(faucetPage, /ClawdPow\.solve/);
    const explorerPage = await (await fetch(explorer.base + '/explorer')).text();
    assert.match(explorerPage, /<script src="\/chain\.js"><\/script>/);
    assert.doesNotMatch(explorerPage, /type=["']module["']/);

    return {
      priorityFeeEstimate: fee.json.result.priorityFeeEstimate,
      priorityFeeLevels: fee.json.result.priorityFeeLevels,
      blockedStatus: blocked.status,
      blockedMethod: 'getProgramAccounts',
      airdropAmount: drop.json.amount,
      airdropSignature: drop.json.signature,
      airdropLamports: airdropCall.params[1],
      walletRemaining: quotaAfter.json.walletRemaining,
      ipRemaining: quotaAfter.json.ipRemaining,
      otherWalletRemaining: quotaOther.json.walletRemaining,
      otherIpRemaining: quotaOther.json.ipRemaining,
      tokenMint: info.mint,
      tokenAmount: info.tokenAmount.amount,
      ratePerIp: status.json.ratePerIp,
    };
  } finally {
    await gateway.close();
    await faucet.close();
    await explorer.close();
    await fake.close();
  }
}

module.exports = {
  ROOT,
  WALLET,
  IP_A,
  IP_B,
  FEE_LEVELS,
  solvePow,
  failPow,
  eachCall,
  countMethod,
  freePort,
  startFake,
  startNode,
  primaryRespond,
  req,
  runPrimaryChecks,
};

if (require.main === module) {
  runPrimaryChecks().then(summary => {
    console.log('PASS ' + JSON.stringify(summary));
    process.exit(0);
  }).catch(err => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}
