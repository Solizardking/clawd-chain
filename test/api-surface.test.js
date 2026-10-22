const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function startApi(port) {
  const child = spawn(process.execPath, ['api/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('api did not listen')), 8000);
    let log = '';
    const onData = chunk => {
      log += chunk;
      if (log.includes('clawd api on')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`api exited ${code}: ${log}`));
    });
  });
  return { child, ready };
}

test('openapi and mcp name NFT, token, agent, and x402 without a signer', async () => {
  const port = await freePort();
  const { child, ready } = startApi(port);
  try {
    await ready;
    const base = `http://127.0.0.1:${port}`;
    const specRes = await fetch(`${base}/openapi.json`);
    assert.equal(specRes.status, 200);
    const specText = await specRes.text();
    assert.match(specText, /NFT/);
    assert.match(specText, /token/);
    assert.match(specText, /agent/);
    assert.match(specText, /x402/);
    assert.match(specText, /CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d/);
    assert.match(specText, /1DREGFgysWYxLnRnKQnwrxnJQeSMk2HmGaC6whw2B2p/);
    const listed = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const tools = (await listed.json()).result.tools;
    const names = tools.map(tool => tool.name);
    for (const name of ['get_nft', 'get_token', 'get_agent', 'payment_info']) assert.ok(names.includes(name), name);
    assert.equal(names.some(name => /airdrop|solve|pow/i.test(name)), false);
    assert.equal(tools.every(tool => tool.annotations.readOnlyHint === true), true);
    const pay = await (await fetch(`${base}/x402`)).json();
    assert.equal(pay.network, 'clawd');
    assert.ok(pay.schemes.includes('x402'));
    assert.equal(pay.feePayer, 'facilitator');
    const bad = await fetch(`${base}/nft/not-an-address`);
    assert.equal(bad.status, 400);
    console.log('openapi names NFT token agent x402');
    console.log(`mcp tools ${names.filter(name => /nft|token|agent|payment/.test(name)).join(' ')}`);
  } finally {
    child.kill('SIGTERM');
  }
});
