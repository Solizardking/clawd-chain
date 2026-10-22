const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto, createHash } = require('node:crypto');
const { browserSandbox, extractScripts } = require('../scripts/browser-scripts');

const ROOT = path.join(__dirname, '..', 'extension');
const SEED = 'seed-do-not-leak-9f3a';

function storageMock() {
  const saved = {};
  return {
    local: {
      get(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const key of list) out[key] = saved[key];
        return Promise.resolve(out);
      },
      set(obj) {
        Object.assign(saved, obj);
        return Promise.resolve();
      },
    },
    saved,
  };
}

function installBrowser(fetchImpl, storage) {
  const ctx = browserSandbox();
  ctx.sandbox.TextEncoder = TextEncoder;
  ctx.sandbox.TextDecoder = TextDecoder;
  ctx.sandbox.crypto = webcrypto;
  ctx.sandbox.chrome = { storage };
  ctx.sandbox.importScripts = function importScripts(...files) {
    for (const file of files) {
      if (file.includes('..')) throw new Error('script path escapes extension: ' + file);
      const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
      vm.runInContext(code, ctx.sandbox, { filename: file });
    }
  };
  ctx.sandbox.fetch = fetchImpl;
  return ctx;
}

function loadScripts(ctx, files) {
  for (const file of files) {
    const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
    if (/\brequire\s*\(/.test(code)) throw new Error(file + ' calls require');
    vm.runInContext(code, ctx.sandbox, { filename: file });
  }
}

function rpcFetch(calls) {
  return async function fetch(url, opts) {
    calls.push({ url: String(url), body: opts && opts.body ? String(opts.body) : '' });
    const message = JSON.parse(opts.body);
    if (message.method === 'getBalance') {
      return { ok: true, json: async () => ({ result: { value: 2500000000 } }) };
    }
    if (message.method === 'getTokenAccountsByOwner') {
      return {
        ok: true,
        json: async () => ({
          result: {
            value: [
              {
                account: {
                  data: {
                    parsed: {
                      info: { mint: 'MintPup', tokenAmount: { amount: '42', decimals: 0 } },
                    },
                  },
                },
              },
            ],
          },
        }),
      };
    }
    if (message.method === 'getAccountInfo') {
      return {
        ok: true,
        json: async () => ({
          result: {
            value: {
              data: {
                parsed: {
                  info: { extensions: [{ extension: 'tokenMetadata', state: { name: 'Clawd Pup' } }] },
                },
              },
            },
          },
        }),
      };
    }
    return { ok: true, json: async () => ({ result: null }) };
  };
}

test('manifest is v3 and the popup and worker scripts install the wallet', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.equal(manifest.background.service_worker, 'background.js');
  const extensionFiles = ['manifest.json', 'popup.html', 'popup.js', 'background.js', 'wallet.js', 'names.js', 'pow.js'];
  for (const file of extensionFiles) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.equal(text.includes('mainnet-beta'), false);
  }

  const html = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
  const scripts = extractScripts(html);
  assert.equal(scripts.some(script => String(script.type).toLowerCase() === 'module'), false);
  const calls = [];
  const storage = storageMock();
  const popup = installBrowser(rpcFetch(calls), storage);
  loadScripts(popup, scripts.map(script => script.src));
  assert.equal(typeof popup.sandbox.module, 'undefined');
  assert.equal(typeof popup.sandbox.require, 'undefined');
  assert.equal(typeof popup.sandbox.ClawdWallet, 'object');
  assert.equal(popup.sandbox.ClawdWallet.RPC, 'https://rpc.clawdchain.trade');
  await popup.sandbox.__clawdBoot;
  assert.match(popup.sandbox.document.getElementById('balance').textContent, /2\.5 CLAWD/);
  assert.match(popup.sandbox.document.getElementById('holdings').textContent, /Clawd Pup/);
  const rendered = popup.sandbox.ClawdWallet.renderHoldings(
    popup.sandbox.document.getElementById('holdings'),
    [{ name: 'Clawd Pup', balance: '42', mint: 'MintPup' }],
  );
  assert.match(rendered, /Clawd Pup/);
  assert.equal(rendered.startsWith('MintPup'), false);

  const hostile = '<img src=x onerror=alert(1)>';
  popup.sandbox.fetch = async function fetch(url, opts) {
    calls.push({ url: String(url), body: opts && opts.body ? String(opts.body) : '' });
    const message = JSON.parse(opts.body);
    if (message.method === 'getBalance') {
      return { ok: true, json: async () => ({ result: { value: 2500000000 } }) };
    }
    if (message.method === 'getTokenAccountsByOwner') {
      return {
        ok: true,
        json: async () => ({
          result: {
            value: [{
              account: {
                data: { parsed: { info: { mint: 'MintPup', tokenAmount: { amount: '42', decimals: 0 } } } },
              },
            }],
          },
        }),
      };
    }
    if (message.method === 'getAccountInfo') {
      return {
        ok: true,
        json: async () => ({
          result: {
            value: {
              data: {
                parsed: {
                  info: { extensions: [{ extension: 'tokenMetadata', state: { name: hostile } }] },
                },
              },
            },
          },
        }),
      };
    }
    return { ok: true, json: async () => ({ result: null }) };
  };
  const holdingsEl = popup.sandbox.document.getElementById('holdings');
  holdingsEl.innerHTML = 'untouched';
  await popup.sandbox.ClawdWallet.refresh();
  assert.equal(holdingsEl.textContent, hostile + ' · 42');
  assert.equal(holdingsEl.innerHTML, 'untouched');

  const first = await popup.sandbox.ClawdWallet.createOrRestore(SEED);
  const restored = await popup.sandbox.ClawdWallet.createOrRestore(SEED);
  assert.equal(first.address, restored.address);
  popup.sandbox.ClawdWallet.lock();
  const fromStorage = await popup.sandbox.ClawdWallet.createOrRestore();
  assert.equal(fromStorage.address, first.address);
  calls.length = 0;
  await popup.sandbox.ClawdWallet.refresh();
  popup.sandbox.document.getElementById('to').value = 'DestWallet111';
  popup.sandbox.document.getElementById('amount').value = '1.25';
  await popup.sandbox.document.getElementById('send').onclick();
  const signedText = popup.sandbox.document.getElementById('signed').textContent;
  assert.match(signedText, new RegExp(first.address));
  assert.match(signedText, /DestWallet111/);
  assert.match(signedText, /1\.25/);
  const signed = await popup.sandbox.ClawdWallet.buildTransfer({ recipient: 'DestWallet111', amount: '1.25' });
  assert.equal(signed.sender, first.address);
  assert.equal(signed.recipient, 'DestWallet111');
  assert.equal(signed.amount, '1.25');
  const pub = await webcrypto.subtle.importKey(
    'jwk',
    { kty: 'OKP', crv: 'Ed25519', x: signed.publicKey, ext: true },
    { name: 'Ed25519' },
    true,
    ['verify'],
  );
  const ok = await webcrypto.subtle.verify(
    { name: 'Ed25519' },
    pub,
    Buffer.from(signed.signature, 'hex'),
    new TextEncoder().encode(signed.payload),
  );
  assert.equal(ok, true);
  const leaked = JSON.stringify(calls);
  assert.equal(leaked.includes(SEED), false);
  assert.equal(JSON.stringify(signed).includes(SEED), false);
  for (const call of calls) {
    assert.equal(call.url.startsWith('https://rpc.clawdchain.trade'), true);
  }

  const workerCalls = [];
  const worker = installBrowser(rpcFetch(workerCalls), storageMock());
  loadScripts(worker, ['background.js']);
  assert.equal(typeof worker.sandbox.ClawdWallet.createOrRestore, 'function');
  assert.equal(typeof worker.sandbox.ClawdBackground.unlock, 'function');
  assert.equal(worker.sandbox.ClawdBackground.rpc, 'https://rpc.clawdchain.trade');
  const workerKey = await worker.sandbox.ClawdBackground.unlock(SEED);
  assert.equal(workerKey.address, first.address);
  console.log('PASS extension popup balance 2.5 CLAWD holdings Clawd Pup transfer ' + signed.sender);
});

test('Get CLAWD solves the faucet proof for the local wallet', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  assert.equal(manifest.host_permissions.includes('https://rpc.clawdchain.trade/*'), true);
  assert.equal(manifest.host_permissions.includes('https://faucet.clawdchain.trade/*'), true);
  const html = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
  assert.match(html, /id="pinch"/);
  assert.match(html, /id="faucet"/);
  assert.equal(fs.readFileSync(path.join(ROOT, 'pow.js'), 'utf8'), fs.readFileSync(path.join(ROOT, '..', 'faucet', 'pow.js'), 'utf8'));

  const calls = [];
  function fetchImpl(url, opts) {
    const target = String(url);
    const body = opts && opts.body ? String(opts.body) : '';
    calls.push({ url: target, body, method: opts && opts.method ? opts.method : 'GET' });
    if (target === 'https://faucet.clawdchain.trade/challenge') {
      return Promise.resolve({ ok: true, json: async () => ({ challenge: 'pinch-challenge', bits: 8 }) });
    }
    if (target === 'https://faucet.clawdchain.trade/airdrop') {
      return Promise.resolve({ ok: true, json: async () => ({ signature: 'sigPinch', amount: 5 }) });
    }
    return rpcFetch([])(url, opts);
  }

  const popup = installBrowser(fetchImpl, storageMock());
  const scripts = extractScripts(html).map(script => script.src);
  loadScripts(popup, scripts);
  await popup.sandbox.__clawdBoot;
  for (const call of calls) assert.equal(call.url.startsWith('https://rpc.clawdchain.trade'), true);
  assert.equal(popup.sandbox.document.getElementById('pinch').disabled, false);

  let yields = 0;
  popup.sandbox.setTimeout = function (fn) {
    yields += 1;
    fn();
    return 1;
  };
  const stepped = await popup.sandbox.ClawdPow.solve('yield-check', 10, { every: 2 });
  assert.equal(yields > 0, true);
  const steppedHash = createHash('sha256').update('yield-check:' + stepped.nonce).digest();
  assert.equal(Buffer.from(stepped.hash).equals(steppedHash), true);

  calls.length = 0;
  await popup.sandbox.document.getElementById('pinch').onclick();
  assert.equal(popup.sandbox.document.getElementById('faucet').textContent, '+5 CLAWD');
  const challenge = calls.find(call => call.url.endsWith('/challenge'));
  const drop = calls.find(call => call.url.endsWith('/airdrop'));
  assert.equal(challenge.method, 'GET');
  assert.equal(drop.method, 'POST');
  const posted = JSON.parse(drop.body);
  assert.equal(posted.address, popup.sandbox.ClawdWallet.getAddress());
  assert.equal(posted.challenge, 'pinch-challenge');
  const proof = createHash('sha256').update(posted.challenge + ':' + posted.nonce).digest();
  let zeros = 0;
  for (const byte of proof) {
    if (byte === 0) { zeros += 8; continue; }
    zeros += Math.clz32(byte) - 24;
    break;
  }
  assert.equal(zeros >= 8, true);
  assert.equal(JSON.stringify(calls).includes(SEED), false);
  console.log('PASS extension Get CLAWD nonce ' + posted.nonce);
});
