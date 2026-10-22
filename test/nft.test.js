const test = require('node:test');
const assert = require('node:assert/strict');
const { Connection, PublicKey } = require('@solana/web3.js');
const nft = require('../chain/nft');

const RPC = process.env.CLAWD_RPC || 'http://127.0.0.1:18899';

test('createNft rejects a name over 32 characters before a transaction', async () => {
  const umi = nft.clawdUmi(RPC);
  await assert.rejects(
    () => nft.createNft(umi, {
      name: 'n'.repeat(33),
      uri: 'https://clawd.local/too-long.json',
      metadata: { name: 'n', description: 'd', image: 'https://clawd.local/n.png' },
    }),
    /32/,
  );
});

test('core nft create, fetch, update, transfer, and burn', { timeout: 180000 }, async () => {
  const health = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
  }).then(r => r.json());
  assert.equal(health.result, 'ok');

  const umi = nft.clawdUmi(RPC);
  const payer = nft.generateSigner(umi);
  umi.use(nft.keypairIdentity(payer));
  await nft.fund(umi, payer, 2);

  const metadata = {
    name: 'Clawd Crab',
    description: 'A clawd chain core nft',
    image: 'https://clawd.local/crab.png',
  };
  const created = await nft.createNft(umi, {
    name: metadata.name,
    uri: 'https://clawd.local/crab.json',
    metadata,
  });
  assert.equal(created.metadata.name, metadata.name);
  assert.equal(created.metadata.description, metadata.description);
  assert.equal(created.metadata.image, metadata.image);

  const fetched = await nft.fetchNft(umi, created.asset);
  assert.equal(fetched.ok, true, fetched.reason);
  assert.equal(fetched.name, created.name);
  assert.equal(fetched.uri, created.uri);
  assert.equal(fetched.owner, payer.publicKey.toString());
  console.log(`fetched NFT name ${fetched.name}`);

  const updated = await nft.updateNft(umi, {
    asset: created.asset,
    name: 'Clawd Crab 2',
    uri: 'https://clawd.local/crab.json?v=2',
  });
  assert.equal(updated.name, 'Clawd Crab 2');
  assert.equal(updated.uri, 'https://clawd.local/crab.json?v=2');
  console.log(`updated name ${updated.name}`);

  const recipient = nft.generateSigner(umi);
  const connection = new Connection(RPC, 'confirmed');
  const before = await connection.getAccountInfo(new PublicKey(recipient.publicKey.toString()));
  assert.equal(before, null);
  const transferred = await nft.transferNft(umi, { asset: created.asset, newOwner: recipient.publicKey });
  assert.equal(transferred.owner, recipient.publicKey.toString());
  console.log(`post-transfer owner ${transferred.owner}`);
  console.log(`new owner ${transferred.owner}`);

  const burned = await nft.burnNft(umi, { asset: created.asset, authority: recipient });
  assert.equal(burned.ok, false);
  assert.equal(burned.gone, true);
  console.log(`burn-not-found ${burned.reason}`);
});
