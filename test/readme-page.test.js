const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function startExplorer(port) {
  const child = spawn(process.execPath, ['explorer/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), VALIDATOR_RPC: 'http://127.0.0.1:9' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('explorer did not listen\n' + log)), 8000);
    child.stdout.on('data', (buf) => {
      log += buf.toString();
      if (log.includes('explorer on')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (buf) => { log += buf.toString(); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('explorer exited ' + code + '\n' + log));
    });
  });
  return { child, ready };
}

test('the animated readme mounts the extension wallet on the explorer', async () => {
  const port = await freePort();
  const explorer = startExplorer(port);
  try {
    await explorer.ready;
    const base = 'http://127.0.0.1:' + port;
    const readme = await fetch(base + '/readme');
    const html = await readme.text();
    assert.equal(readme.status, 200);
    assert.match(html, /THE KEY NEVER LEAVES/);
    assert.match(html, /id="balance"/);
    assert.match(html, /id="wallet"/);
    assert.match(html, /src="\/extension\/wallet\.js"/);
    assert.match(html, /src="\/readme\.js"/);
    assert.match(html, /canvas id="rain"/);

    const alias = await fetch(base + '/wallet');
    assert.equal(alias.status, 200);
    assert.match(await alias.text(), /id="balance"/);

    const home = await fetch(base + '/');
    assert.match(await home.text(), /href="\/readme"/);
    const explored = await fetch(base + '/explorer');
    assert.match(await explored.text(), /href="\/readme"/);

    const walletJs = await fetch(base + '/extension/wallet.js');
    assert.equal(walletJs.status, 200);
    const source = await walletJs.text();
    assert.match(source, /https:\/\/rpc\.clawdchain\.trade/);
    assert.equal(source, fs.readFileSync(path.join(ROOT, 'extension', 'wallet.js'), 'utf8'));

    const blocked = await fetch(base + '/extension/manifest.json');
    assert.equal(blocked.status, 404);
    const missing = await fetch(base + '/extension/not-a-wallet.js');
    assert.equal(missing.status, 404);
    console.log('PASS readme page mounts extension wallet');
  } finally {
    explorer.child.kill();
  }
});
