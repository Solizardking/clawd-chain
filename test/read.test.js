const test = require('node:test');
const assert = require('node:assert/strict');
const { Keypair } = require('@solana/web3.js');
const { decodeAccount, describeAccount } = require('../api/lib/read');
const { PROGRAMS } = require('../api/lib/programs');

test('core nft decoder reads name and owner from an asset account', () => {
  const owner = Keypair.generate().publicKey;
  const name = 'Clawd Crab';
  const uri = 'https://clawd.local/crab.json';
  const buf = Buffer.alloc(34 + 4 + name.length + 4 + uri.length);
  buf[0] = 1;
  owner.toBuffer().copy(buf, 1);
  buf[33] = 0;
  buf.writeUInt32LE(name.length, 34);
  buf.write(name, 38);
  const uriAt = 38 + name.length;
  buf.writeUInt32LE(uri.length, uriAt);
  buf.write(uri, uriAt + 4);
  const decoded = decodeAccount(PROGRAMS.core, buf);
  assert.equal(decoded.kind, 'nft');
  assert.equal(decoded.name, name);
  assert.equal(decoded.uri, uri);
  assert.equal(decoded.owner, owner.toBase58());
});

test('agent identity decoder reads the asset and an empty token bind', () => {
  const asset = Keypair.generate().publicKey;
  const buf = Buffer.alloc(104);
  asset.toBuffer().copy(buf, 8);
  const decoded = decodeAccount(PROGRAMS.agentIdentity, buf);
  assert.equal(decoded.kind, 'agent');
  assert.equal(decoded.asset, asset.toBase58());
  assert.equal(decoded.agentToken, null);
});

test('token mint decoder reads supply and decimals', () => {
  const buf = Buffer.alloc(82);
  buf.writeBigUInt64LE(1000n, 36);
  buf[44] = 6;
  buf[45] = 1;
  const decoded = decodeAccount(PROGRAMS.token2022, buf);
  assert.equal(decoded.kind, 'token');
  assert.equal(decoded.supply, '1000');
  assert.equal(decoded.decimals, 6);
});

test('token account decoder reads the amount', () => {
  const mint = Keypair.generate().publicKey;
  const owner = Keypair.generate().publicKey;
  const buf = Buffer.alloc(165);
  mint.toBuffer().copy(buf, 0);
  owner.toBuffer().copy(buf, 32);
  buf.writeBigUInt64LE(400n, 64);
  const decoded = decodeAccount(PROGRAMS.token, buf);
  assert.equal(decoded.kind, 'token-account');
  assert.equal(decoded.amount, '400');
  assert.equal(decoded.mint, mint.toBase58());
  assert.equal(decoded.owner, owner.toBase58());
});

test('describeAccount reports a missing account', () => {
  assert.deepEqual(describeAccount('missing', { value: null }), { address: 'missing', exists: false });
});
