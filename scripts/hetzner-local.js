'use strict';
// One cold start of the shipped gateway, faucet, explorer, API, and payments
// facilitator using the Hetzner deploy env, against the in-repo fake validator.
const crypto = require('crypto');
const path = require('path');
const { loadHetznerDeploy, localGatewayUrl } = require('../deploy/hetzner');
const { WALLET, solvePow, freePort, startFake, startNode, req } = require('./service-check');

const TRACE = path.join(__dirname, 'hetzner-fetch-trace.js');

function respond(slot, signature) {
  return function handler(body) {
    if (Array.isArray(body)) return body.map(handler);
    const id = body && Object.prototype.hasOwnProperty.call(body, 'id') ? body.id : null;
    const method = body && body.method;
    if (method === 'getHealth') return { jsonrpc: '2.0', id, result: 'ok' };
    if (method === 'getSlot') return { jsonrpc: '2.0', id, result: slot };
    if (method === 'requestAirdrop') return { jsonrpc: '2.0', id, result: signature };
    if (method === 'getMinimumBalanceForRentExemption') return { jsonrpc: '2.0', id, result: 890880 };
    return { jsonrpc: '2.0', id, result: { ok: true, method } };
  };
}

function upstreamLine(output) {
  const line = output.split('\n').find(item => item.startsWith('FAUCET_UPSTREAM '));
  if (!line) return null;
  return JSON.parse(line.slice('FAUCET_UPSTREAM '.length));
}

async function runOnce() {
  const deploy = loadHetznerDeploy();
  const slot = 100000 + crypto.randomInt(800000);
  const signature = 'sig-' + crypto.randomBytes(8).toString('hex');
  const faucetKey = 'hetzner-' + crypto.randomBytes(8).toString('hex');
  const powSecret = 'pow-' + crypto.randomBytes(8).toString('hex');
  const fake = await startFake(respond(slot, signature));
  const gatewayPort = String(await freePort());
  const faucetPort = String(await freePort());
  const explorerPort = String(await freePort());
  const apiPort = String(await freePort());
  const paymentsPort = String(await freePort());
  const gatewayRpc = localGatewayUrl(deploy['x-hetzner'].gatewayUrl, gatewayPort);
  const gateway = await startNode('proxy.js', {
    PORT: gatewayPort,
    UPSTREAM_HTTP: fake.url,
    FAUCET_KEY: faucetKey,
  }, '/');
  const faucet = await startNode('faucet/server.js', {
    PORT: faucetPort,
    VALIDATOR_RPC: gatewayRpc,
    FAUCET_KEY: faucetKey,
    POW_SECRET: powSecret,
    POW_BITS: '8',
    NODE_OPTIONS: '--require ' + TRACE,
  }, '/health');
  const explorer = await startNode('explorer/server.js', {
    PORT: explorerPort,
    VALIDATOR_RPC: gatewayRpc,
  }, '/health');
  const api = await startNode('api/server.js', {
    PORT: apiPort,
    VALIDATOR_RPC: gatewayRpc,
  }, '/health');
  const payments = await startNode('payments/server.js', {
    PORT: paymentsPort,
    CLAWD_RPC: gatewayRpc,
  }, '/health');
  try {
    const health = await req(gateway.base + '/', {
      method: 'POST',
      body: { jsonrpc: '2.0', id: 1, method: 'getHealth' },
    });
    const slotRes = await req(gateway.base + '/', {
      method: 'POST',
      body: { jsonrpc: '2.0', id: 2, method: 'getSlot' },
    });
    const blocked = await req(gateway.base + '/', {
      method: 'POST',
      body: { jsonrpc: '2.0', id: 3, method: 'requestAirdrop', params: [WALLET, 1000000000] },
    });
    const blockedPrograms = await req(gateway.base + '/', {
      method: 'POST',
      body: { jsonrpc: '2.0', id: 4, method: 'getProgramAccounts', params: ['11111111111111111111111111111111'] },
    });
    const blockedLargest = await req(gateway.base + '/', {
      method: 'POST',
      body: { jsonrpc: '2.0', id: 5, method: 'getLargestAccounts' },
    });
    const seenBefore = fake.seen.length;
    const challenge = await req(faucet.base + '/challenge');
    const nonce = solvePow(challenge.json.challenge, challenge.json.bits);
    const drop = await req(faucet.base + '/airdrop', {
      method: 'POST',
      headers: { 'x-forwarded-for': '198.51.100.10' },
      body: { address: WALLET, challenge: challenge.json.challenge, nonce },
    });
    const upstream = upstreamLine(faucet.output());
    const explorerHealth = await req(explorer.base + '/api/rpc', {
      method: 'POST',
      body: { method: 'getHealth' },
    });
    const apiSlot = await req(api.base + '/mcp', {
      method: 'POST',
      headers: { accept: 'application/json' },
      body: { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_slot', arguments: {} } },
    });
    const supported = await req(payments.base + '/supported');
    const mintPage = await req(explorer.base + '/mint/');
    const mintScript = await req(explorer.base + '/mint/mint.js');
    const transcript = {
      host: deploy['x-hetzner'].hostname,
      ipv4: deploy['x-hetzner'].ipv4,
      gateway: gateway.base,
      getHealth: health.json,
      getSlot: slotRes.json,
      blockedAirdrop: blocked.status,
      blockedProgramAccounts: blockedPrograms.status,
      blockedLargestAccounts: blockedLargest.status,
      airdrop: drop.json,
      faucetUpstream: upstream,
      upstreamAirdropsAfterFaucet: fake.seen.slice(seenBefore).filter(call => {
        const list = Array.isArray(call) ? call : [call];
        return list.some(item => item && item.method === 'requestAirdrop');
      }).length,
      explorerHealth: explorerHealth.json,
      apiSlot: apiSlot.json,
      payments: supported.json,
      paymentsStatus: supported.status,
      mintPage: mintPage.text,
      mintStatus: mintPage.status,
      mintScript: mintScript.text,
      mintScriptStatus: mintScript.status,
    };
    return transcript;
  } finally {
    await gateway.close();
    await faucet.close();
    await explorer.close();
    await api.close();
    await payments.close();
    await fake.close();
  }
}

module.exports = { runOnce, upstreamLine };

if (require.main === module) {
  runOnce().then(transcript => {
    console.log(JSON.stringify(transcript, null, 2));
    const healthOk = transcript.getHealth && transcript.getHealth.result === 'ok';
    const slotOk = Number.isFinite(transcript.getSlot && transcript.getSlot.result);
    const headerOk = transcript.faucetUpstream && transcript.faucetUpstream.faucetKey
      && transcript.faucetUpstream.url === transcript.gateway;
    const schemes = (transcript.payments && transcript.payments.kinds || []).map(kind => kind.scheme);
    const payOk = transcript.paymentsStatus === 200
      && transcript.payments && transcript.payments.network === 'clawd'
      && ['exact', 'x402', 'mpp'].every(scheme => schemes.includes(scheme));
    const mintOk = transcript.mintStatus === 200
      && transcript.mintPage.includes('mint.js')
      && transcript.mintScriptStatus === 200
      && transcript.mintScript.length > 0;
    if (!healthOk || !slotOk || !headerOk || !payOk || !mintOk || transcript.blockedAirdrop !== 403) {
      process.exitCode = 1;
    }
  }).catch(err => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}
