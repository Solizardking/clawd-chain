const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Keypair } = require('@solana/web3.js');
const { createRegistry, validate } = require('../payments/registry');
const { createPaymentsServer, listen } = require('../payments/server');

const payTo = Keypair.generate().publicKey.toBase58();
const good = { name: 'Lobster oracle', url: 'https://example.com/oracle', price: '1000000', payTo, schemes: ['exact', 'mpp'], tags: ['AI'] };

test('validation rejects bad urls, addresses, prices, and schemes', () => {
  assert.equal(validate('resource', good).ok, true);
  const bad = validate('resource', { name: 'x', url: 'http://127.0.0.1/a', price: '-1', payTo: 'nope', schemes: ['card'] });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 5);
  assert.equal(validate('resource', { ...good, url: 'https://10.0.0.1/x' }).ok, false);
  assert.equal(validate('resource', { ...good, url: 'https://u:p@example.com/x' }).ok, false);
  assert.equal(validate('facilitator', { name: 'My fac', url: 'https://fac.example.com' }).ok, true);
  assert.equal(validate('facilitator', { name: 'My fac', url: 'https://fac.example.com', feePayer: 'bad' }).ok, false);
  assert.equal(validate('wallet', good).ok, false);
  const stripped = validate('resource', { ...good, name: '<script>Lob</script>' });
  assert.equal(stripped.entry.name.includes('<'), false);
});

test('registry persists to a file, rejects duplicates, and rate limits per ip', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reg-')), 'sub', 'registry.json');
  const reg = createRegistry({ file, perWindow: 2 });
  assert.equal(reg.add('resource', good, 'a').status, 201);
  assert.equal(reg.add('resource', good, 'a').status, 409);
  assert.equal(reg.add('resource', { ...good, url: 'https://example.com/2' }, 'a').status, 201);
  assert.equal(reg.add('resource', { ...good, url: 'https://example.com/3' }, 'a').status, 429);
  assert.equal(reg.add('resource', { ...good, url: 'https://example.com/3' }, 'b').status, 201);
  const again = createRegistry({ file });
  assert.equal(again.count(), 3);
  assert.equal(again.list('resource', { q: 'ai' }).total, 3);
  assert.equal(again.list('facilitator').total, 0);
  assert.equal(fs.readFileSync(file, 'utf8').includes('secret'), false);
});

test('payments root serves the page and the registry routes over http', async () => {
  const connection = { getMinimumBalanceForRentExemption: async () => 890880 };
  const app = createPaymentsServer({ connection, registry: createRegistry({ file: '' }) });
  const base = await listen(app);
  try {
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const html = await page.text();
    assert.match(html, /🦞/);
    assert.match(html, /\/registry\//);
    const posted = await fetch(base + '/registry/resources', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(good) });
    assert.equal(posted.status, 201);
    const entry = await posted.json();
    assert.match(entry.id, /^[0-9a-f]{16}$/);
    const invalid = await fetch(base + '/registry/facilitators', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"x"}' });
    assert.equal(invalid.status, 400);
    const disc = await (await fetch(base + '/discovery/resources')).json();
    assert.equal(disc.x402Version, 1);
    assert.equal(disc.items[0].resource, good.url);
    assert.deepEqual(disc.items[0].accepts.map(a => a.scheme), ['exact', 'mpp']);
    assert.equal(disc.items[0].accepts[0].maxAmountRequired, '1000000');
    const one = await fetch(base + '/registry/' + entry.id);
    assert.equal(one.status, 200);
    const info = await (await fetch(base + '/registry')).json();
    assert.equal(info.resources, 1);
    const supported = await (await fetch(base + '/supported')).json();
    assert.equal(supported.network, 'clawd');
  } finally {
    app.server.close();
  }
});

test('api intro lists every live url and the mcp exposes registry read tools', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'api/server.js'), 'utf8');
  for (const host of ['clawdchain.trade', 'explorer.clawdchain.trade', 'rpc.clawdchain.trade', 'faucet.clawdchain.trade', 'api.clawdchain.trade', 'mcp.clawdchain.trade/mcp', 'payments.clawdchain.trade', 'mint.clawdchain.trade']) {
    assert.equal(src.includes(host), true, host);
  }
  assert.match(src, /list_x402_resources/);
  assert.match(src, /list_x402_facilitators/);
  assert.equal(src.includes('chain/nft.js'), false);
});
