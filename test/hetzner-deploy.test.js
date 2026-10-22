const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { COMPOSE_PATH, loadHetznerDeploy } = require('../deploy/hetzner');
const { runOnce } = require('../scripts/hetzner-local');

const ROOT = path.join(__dirname, '..');

const RAILWAY = /clawd-validator\.railway\.internal|clawd-validator-production\.up\.railway\.app/;
const SECRET_VALUE = /(?:FAUCET_KEY|POW_SECRET|SUPERMEMORY_API_KEY)"\s*:\s*"(?!\$\{)[^"]+"/;

function assertStack(transcript) {
  assert.equal(transcript.getHealth.result, 'ok');
  assert.equal(typeof transcript.getSlot.result, 'number');
  assert.equal(Number.isFinite(transcript.getSlot.result), true);
  assert.equal(transcript.blockedAirdrop, 403);
  assert.equal(transcript.blockedProgramAccounts, 403);
  assert.equal(transcript.blockedLargestAccounts, 403);
  assert.equal(transcript.airdrop.signature.startsWith('sig-'), true);
  assert.equal(transcript.upstreamAirdropsAfterFaucet, 1);
  assert.equal(transcript.faucetUpstream.url, transcript.gateway);
  assert.equal(transcript.faucetUpstream.faucetKey.startsWith('hetzner-'), true);
  assert.equal(transcript.explorerHealth.result, 'ok');
  const slotText = JSON.stringify(transcript.apiSlot);
  assert.equal(slotText.includes(String(transcript.getSlot.result)), true);
  assert.equal(transcript.paymentsStatus, 200);
  assert.equal(transcript.payments.network, 'clawd');
  const schemes = transcript.payments.kinds.map(kind => kind.scheme);
  for (const scheme of ['exact', 'x402', 'mpp']) {
    assert.equal(schemes.includes(scheme), true, scheme);
  }
  assert.equal(transcript.mintStatus, 200);
  assert.equal(transcript.mintPage.includes('mint.js'), true);
  assert.equal(transcript.mintPage.includes('mint/index.html') || transcript.mintPage.includes('Clawd public mint'), true);
  assert.equal(transcript.mintScriptStatus, 200);
  assert.equal(transcript.mintScript.length > 0, true);
}

test('hetzner compose names the host, ledger, and gateway RPCs', () => {
  const text = fs.readFileSync(COMPOSE_PATH, 'utf8');
  const deploy = loadHetznerDeploy();
  const host = deploy['x-hetzner'];
  assert.equal(host.hostname, 'ubuntu-24gb-hel1-1');
  assert.equal(host.ipv4, '95.216.154.157');
  assert.equal(host.ipv6, '2a01:4f9:c015:fe8f::/64');
  assert.equal(host.ipv6Host, '2a01:4f9:c015:fe8f::1');
  assert.equal(host.ledgerMount, '/data');
  assert.equal(host.ledgerPath, '/data/ledger');
  assert.equal(host.gatewayUrl, 'http://validator:8080');
  assert.equal(deploy.services.validator.volumes[0], 'clawd-ledger:/data');
  assert.equal(deploy.volumes['clawd-ledger'].name, 'clawd-ledger');
  for (const name of ['faucet', 'explorer', 'api']) {
    assert.equal(deploy.services[name].environment.VALIDATOR_RPC, host.gatewayUrl);
  }
  assert.equal(deploy.services.payments.environment.CLAWD_RPC, host.gatewayUrl);
  assert.equal(deploy.services.payments.ports[0], '9903:8090');
  assert.equal(deploy.services.validator.environment.FAUCET_KEY, '${FAUCET_KEY}');
  assert.equal(deploy.services.faucet.environment.FAUCET_KEY, '${FAUCET_KEY}');
  assert.equal(deploy.services.faucet.environment.POW_SECRET, '${POW_SECRET}');
  assert.equal(deploy.services.validator.environment.SUPERMEMORY_API_KEY, '${SUPERMEMORY_API_KEY:-}');
  for (const name of ['faucet', 'explorer', 'api']) {
    assert.equal(Object.prototype.hasOwnProperty.call(deploy.services[name].environment, 'SUPERMEMORY_API_KEY'), false);
  }
  assert.equal(JSON.stringify(deploy.services.validator.ports).includes('8091'), false);
  assert.equal(RAILWAY.test(text), false);
  assert.equal(SECRET_VALUE.test(text), false);
  assert.equal(text.includes(host.ipv6), true);
  assert.equal(JSON.stringify(deploy.services).includes(host.ipv6), false);
  assert.equal(JSON.stringify(deploy.services).includes(host.ipv6Host), false);
  assert.equal(text.includes('8899'), false);
  const gateway = 'http://95.216.154.157:8080';
  const defaults = {
    faucet: fs.readFileSync(path.join(ROOT, 'faucet/server.js'), 'utf8'),
    explorer: fs.readFileSync(path.join(ROOT, 'explorer/server.js'), 'utf8'),
    webmcp: fs.readFileSync(path.join(ROOT, 'explorer/public/webmcp.js'), 'utf8'),
    shield: fs.readFileSync(path.join(ROOT, 'clawd-shield-main/scripts/deploy.sh'), 'utf8'),
    payments: fs.readFileSync(path.join(ROOT, 'payments/server.js'), 'utf8'),
  };
  for (const [name, source] of Object.entries(defaults)) {
    assert.equal(RAILWAY.test(source), false, name);
  }
  assert.equal(defaults.faucet.includes(gateway), true);
  assert.equal(defaults.explorer.includes(gateway), true);
  assert.equal(defaults.webmcp.includes(gateway), true);
  assert.equal(defaults.shield.includes(gateway), true);
  assert.equal(defaults.payments.includes(gateway), true);
  const brain = fs.readFileSync(path.join(ROOT, 'brain/server.js'), 'utf8');
  assert.equal(brain.includes('http://127.0.0.1:8899'), true);
  assert.equal(/SUPERMEMORY_API_KEY\s*=\s*['"][^'"]+['"]/.test(brain), false);
});

test('validator boot script and image copy every gateway library', () => {
  const start = fs.readFileSync(path.join(ROOT, 'start.sh'), 'utf8');
  const docker = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  const proxy = fs.readFileSync(path.join(ROOT, 'proxy.js'), 'utf8');
  assert.equal(start.split('\n').some(line => /^\s*PPID=/.test(line)), false);
  assert.match(start, /^PROXY_PID=\$!/m);
  assert.match(start, /kill -0 "\$PROXY_PID"/);
  assert.match(start, /if \[ -n "\$SUPERMEMORY_API_KEY" \]/);
  assert.match(start, /node \/brain\/server\.js/);
  assert.match(docker, /COPY brain \/brain/);
  const proof = execFileSync('bash', ['-c', [
    'set -e',
    'sleep 60 &',
    'eval "$(grep -E \'^(VPID|PROXY_PID)=\' start.sh)"',
    'kill -0 "$VPID"',
    'kill -0 "$PROXY_PID"',
    'kill "$VPID"',
    'echo SURVIVED',
  ].join('\n')], { cwd: ROOT, encoding: 'utf8' });
  assert.match(proof, /SURVIVED/);
  const libs = [...proxy.matchAll(/require\(\s*['"]\.\/lib\/([^'"]+)['"]\s*\)/g)].map(match => match[1]);
  assert.ok(libs.length >= 1);
  for (const lib of libs) {
    const file = lib.endsWith('.js') ? lib : `${lib}.js`;
    const copy = `COPY lib/${file} /lib/${file}`;
    assert.equal(docker.includes(copy), true, copy);
    assert.equal(fs.existsSync(path.join(ROOT, 'lib', file)), true, file);
  }
});

test('two cold starts of the hetzner gateway stack', { timeout: 60000 }, async () => {
  const first = await runOnce();
  assertStack(first);
  const second = await runOnce();
  assertStack(second);
  assert.notEqual(first.getSlot.result, second.getSlot.result);
  assert.notEqual(first.faucetUpstream.faucetKey, second.faucetUpstream.faucetKey);
});
