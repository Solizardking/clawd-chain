const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAgentDocument } = require('../lib/agent-doc');

const valid = {
  type: 'agent',
  name: 'Clawd Agent',
  description: 'Pays and reads on clawd chain',
  services: [{ name: 'payments', endpoint: 'https://clawd.local/pay' }],
  supportedTrust: ['clawd'],
};

test('agent registration document requires name, description, and a service', () => {
  const ok = validateAgentDocument(valid);
  assert.equal(ok.ok, true);
  assert.equal(ok.document.type, 'agent');
  assert.equal(ok.document.name, 'Clawd Agent');
  assert.equal(ok.document.description, valid.description);
  assert.equal(ok.document.services[0].name, 'payments');
  assert.equal(ok.document.services[0].endpoint, 'https://clawd.local/pay');
  assert.deepEqual(ok.document.supportedTrust, ['clawd']);
  const fromJson = validateAgentDocument(JSON.stringify(valid));
  assert.equal(fromJson.ok, true);
  console.log(`agent document service ${ok.document.services[0].name} ${ok.document.services[0].endpoint}`);

  const noService = validateAgentDocument({ ...valid, services: [] });
  assert.equal(noService.ok, false);
  assert.match(noService.reason, /service/);
  const noEndpoint = validateAgentDocument({ ...valid, services: [{ name: 'payments' }] });
  assert.equal(noEndpoint.ok, false);
  assert.match(noEndpoint.reason, /endpoint/);
  const noDescription = validateAgentDocument({ ...valid, description: ' ' });
  assert.equal(noDescription.ok, false);
  const wrongType = validateAgentDocument({ ...valid, type: 'nft' });
  assert.equal(wrongType.ok, false);
  assert.equal(validateAgentDocument('{').ok, false);
  console.log('agent document rejected without a service endpoint');
});
