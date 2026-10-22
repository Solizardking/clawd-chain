const test = require('node:test');
const assert = require('node:assert/strict');
const meta = require('../lib/metadata');

test('nft metadata requires name, description, and image', () => {
  const doc = {
    name: 'Clawd Crab',
    description: 'A clawd chain core nft',
    image: 'https://clawd.local/crab.png',
  };
  const ok = meta.validateNftMetadata(doc);
  assert.equal(ok.ok, true);
  assert.equal(ok.metadata.name, 'Clawd Crab');
  assert.equal(ok.metadata.description, doc.description);
  assert.equal(ok.metadata.image, doc.image);
  const fromJson = meta.validateNftMetadata(JSON.stringify(doc));
  assert.equal(fromJson.ok, true);
  console.log('metadata includes name, description, and image');
  for (const key of ['name', 'description', 'image']) {
    const copy = { ...doc };
    delete copy[key];
    const missing = meta.validateNftMetadata(copy);
    assert.equal(missing.ok, false);
    assert.match(missing.reason, new RegExp(key));
  }
  assert.equal(meta.validateNftMetadata('{').ok, false);
  assert.equal(meta.validateNftMetadata([]).ok, false);
});

test('nft name is at most 32 characters', () => {
  const max = 'a'.repeat(32);
  const accepted = meta.validateNftName(max);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.name, max);
  console.log(`nft name accepted ${accepted.name.length}`);
  const tooLong = meta.validateNftName('b'.repeat(33));
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.reason, 'name must be at most 32 characters');
  console.log('nft name rejected over 32');
  assert.equal(meta.validateNftName('   ').ok, false);
  assert.equal(meta.validateNftName(32).ok, false);
  const wide = meta.validateNftName('🦞'.repeat(9));
  assert.equal(wide.ok, false);
  const created = meta.validateNftCreate({
    name: 'Clawd Crab',
    uri: 'https://clawd.local/crab.json',
    metadata: {
      name: 'Clawd Crab',
      description: 'A clawd chain core nft',
      image: 'https://clawd.local/crab.png',
    },
  });
  assert.equal(created.ok, true);
  assert.equal(created.uri, 'https://clawd.local/crab.json');
  assert.equal(meta.validateNftCreate({ name: 'Clawd Crab', uri: '', metadata: { name: 'n', description: 'd', image: 'i' } }).ok, false);
});
