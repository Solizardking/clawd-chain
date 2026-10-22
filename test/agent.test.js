const test = require('node:test');
const assert = require('node:assert/strict');
const { Connection } = require('@solana/web3.js');
const agent = require('../chain/agent');

const RPC = process.env.CLAWD_RPC || 'http://127.0.0.1:18899';

test('registerAgent rejects a document without a service before a transaction', async () => {
  const umi = agent.agentUmi(RPC);
  await assert.rejects(
    () => agent.registerAgent(umi, {
      asset: '11111111111111111111111111111111',
      uri: 'https://clawd.local/agent.json',
      document: { type: 'agent', name: 'Clawd', description: 'helper', services: [] },
    }),
    /service/,
  );
});

test('agent register, delegate, revoke, and one-mint bind', { timeout: 300000 }, async () => {
  const health = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
  }).then(r => r.json());
  assert.equal(health.result, 'ok');

  const umi = agent.agentUmi(RPC);
  const payer = agent.generateSigner(umi);
  umi.use(agent.keypairIdentity(payer));
  await agent.fund(umi, payer, 8);

  const created = await agent.createNft(umi, {
    name: 'Clawd Agent',
    uri: 'https://clawd.local/agent-asset.json',
    metadata: {
      name: 'Clawd Agent',
      description: 'A clawd chain agent',
      image: 'https://clawd.local/agent.png',
    },
  });
  const document = {
    type: 'agent',
    name: 'Clawd Agent',
    description: 'Pays and answers on clawd chain',
    services: [{ name: 'payments', endpoint: 'https://clawd.local/pay' }],
  };
  const uri = 'https://clawd.local/agent-registration.json';
  const registered = await agent.registerAgent(umi, { asset: created.asset, document, uri });
  assert.equal(registered.uri, uri);
  assert.equal(registered.document.name, document.name);
  assert.equal(registered.document.description, document.description);
  assert.equal(registered.document.services[0].name, 'payments');
  assert.equal(registered.document.services[0].endpoint, 'https://clawd.local/pay');
  assert.notEqual(registered.wallet, registered.asset);
  console.log(`agent wallet ${registered.wallet}`);

  const delegated = await agent.delegateAgent(umi, { asset: created.asset });
  assert.equal(delegated.delegated, true);
  console.log(`delegated executive ${delegated.executive}`);

  const revoked = await agent.revokeAgent(umi, {
    asset: created.asset,
    executive: delegated.executive,
  });
  assert.equal(revoked.delegated, false);
  console.log('delegation absent after revoke');
  console.log('post-revoke delegation state absent');

  const connection = new Connection(RPC, 'confirmed');
  const bound = await agent.bindAgentToken(umi, connection, payer, {
    asset: created.asset,
    name: 'Clawd Agent',
    symbol: 'CLAW',
    supply: 1_000_000n,
    uri: 'https://clawd.local/agent-token.json',
  });
  assert.equal(bound.agentToken, bound.mint);
  assert.notEqual(bound.mint, created.asset);
  console.log(`bound mint ${bound.mint}`);

  await assert.rejects(
    () => agent.bindAgentToken(umi, connection, payer, {
      asset: created.asset,
      name: 'Clawd Agent',
      symbol: 'CLAW',
      supply: 1_000_000n,
      uri: 'https://clawd.local/agent-token-2.json',
    }),
    (error) => {
      const message = error && error.message ? error.message : String(error);
      console.log(`rejected second token bind ${message}`);
      return /already set|Agent Token/i.test(message);
    },
  );
  const again = await agent.readAgent(umi, created.asset);
  assert.equal(again.agentToken, bound.mint);
  console.log(`first mint still reads back ${again.agentToken}`);
});
