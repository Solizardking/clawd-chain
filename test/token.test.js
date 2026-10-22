const test = require('node:test');
const assert = require('node:assert/strict');
const { Connection, Keypair } = require('@solana/web3.js');
const { createFungibleToken, transferFungible } = require('../chain/token');

const RPC = process.env.CLAWD_RPC || 'http://127.0.0.1:18899';

async function fund(connection, owner, lamports) {
  const signature = await connection.requestAirdrop(owner.publicKey, lamports);
  const blockhash = await connection.getLatestBlockhash('confirmed');
  await connection.confirmTransaction({ signature, ...blockhash }, 'confirmed');
}

test('createFungibleToken rejects an empty symbol before a transaction', async () => {
  const connection = new Connection(RPC, 'confirmed');
  await assert.rejects(
    () => createFungibleToken(connection, Keypair.generate(), {
      name: 'Clawd',
      symbol: ' ',
      uri: 'https://clawd.local/token.json',
      supply: 10,
    }),
    /symbol/,
  );
});

test('fungible token create and partial transfer', { timeout: 120000 }, async () => {
  const connection = new Connection(RPC, 'confirmed');
  const health = await connection.getSlot('confirmed');
  assert.ok(health >= 0);

  const payer = Keypair.generate();
  await fund(connection, payer, 2_000_000_000);
  const created = await createFungibleToken(connection, payer, {
    name: 'Clawd Shell',
    symbol: 'CSHL',
    uri: 'https://clawd.local/shell.json',
    decimals: 0,
    supply: 1_000,
  });
  assert.equal(created.name, 'Clawd Shell');
  assert.equal(created.symbol, 'CSHL');
  assert.equal(created.supply, '1000');

  const recipient = Keypair.generate();
  const moved = await transferFungible(connection, payer, {
    mint: created.mint,
    source: created.source,
    owner: payer,
    recipient: recipient.publicKey.toBase58(),
    amount: 400,
  });
  assert.equal(moved.sender, '600');
  assert.equal(moved.recipient, '400');
  console.log(`token balances sender ${moved.sender} recipient ${moved.recipient}`);
});
