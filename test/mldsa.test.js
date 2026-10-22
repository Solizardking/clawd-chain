const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, sign: nodeSign } = require('node:crypto');
const sign = require('../chain/sign');
const chain = require('../chain');

const message = Buffer.from('clawd far intent');

test('ML-DSA-65 keys and signatures match FIPS 204 Table 2', () => {
  assert.equal(chain.generateIdentity, sign.generateIdentity);
  assert.equal(chain.signBytes, sign.signBytes);
  assert.equal(chain.verifyBytes, sign.verifyBytes);
  assert.equal(chain.mlDsaParameterSet, 'ml-dsa-65');
  assert.equal(sign.PARAMETER_SET, 'ml-dsa-65');
  assert.deepEqual(chain.mlDsaSizes, { privateKey: 4032, publicKey: 1952, signature: 3309 });
  assert.equal(Buffer.from(chain.mlDsaContext).toString(), 'clawd');
  assert.ok(chain.mlDsaContext.length <= 255);

  const identity = chain.generateIdentity();
  assert.equal(identity.parameterSet, 'ml-dsa-65');
  const raw = chain.rawPublicKey(identity.publicKey);
  assert.equal(raw.length, 1952);
  const signature = chain.signBytes(identity.privateKey, message);
  assert.equal(Buffer.from(signature, 'hex').length, 3309);
  assert.equal(chain.verifyBytes(sign.publicKeyHex(identity.publicKey), message, signature), true);
  console.log(`ml-dsa-65 pk ${raw.length} sig ${Buffer.from(signature, 'hex').length}`);
});

test('a hedged signature verifies only for its key, message, and context', () => {
  const alice = sign.generateIdentity();
  const bob = sign.generateIdentity();
  const pub = sign.publicKeyHex(alice.publicKey);
  const first = sign.signBytes(alice.privateKey, message);
  const second = sign.signBytes(alice.privateKey, message);
  assert.notEqual(first, second);
  assert.equal(sign.verifyBytes(pub, message, first), true);
  assert.equal(sign.verifyBytes(pub, message, second), true);
  assert.equal(sign.verifyBytes(pub, Buffer.from('other message'), first), false);
  assert.equal(sign.verifyBytes(sign.publicKeyHex(bob.publicKey), message, first), false);

  const flipped = (first.slice(-2) === '00' ? 'ff' : '00');
  const forged = first.slice(0, -2) + flipped;
  assert.equal(Buffer.from(forged, 'hex').length, 3309);
  assert.equal(sign.verifyBytes(pub, message, forged), false);
  assert.equal(sign.verifyBytes(pub, message, first.slice(0, -2)), false);
  assert.equal(sign.verifyBytes(pub, message, first + 'aa'), false);

  const elsewhere = sign.signBytes(alice.privateKey, message, Buffer.from('other-app'));
  assert.equal(sign.verifyBytes(pub, message, elsewhere, Buffer.from('other-app')), true);
  assert.equal(sign.verifyBytes(pub, message, elsewhere), false);
  assert.equal(sign.verifyBytes(pub, message, first, Buffer.from('other-app')), false);
  assert.throws(() => sign.signBytes(alice.privateKey, message, Buffer.alloc(256)), { code: 'CONTEXT' });
  assert.equal(sign.verifyBytes(pub, message, first, Buffer.alloc(256)), false);

  const digest = Buffer.from(sign.sha256Hex(message), 'hex');
  assert.equal(sign.verifyBytes(pub, digest, first), false);

  const stored = alice.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('hex');
  const restored = sign.privateKeyFromHex(stored);
  const again = sign.signBytes(restored, message);
  assert.equal(sign.verifyBytes(pub, message, again), true);
  console.log(`hedged signatures differ ${first !== second}`);
});

test('fresh ML-DSA-65 key pairs are distinct category-3 identities', () => {
  const first = sign.generateIdentity();
  const second = sign.generateIdentity();
  assert.equal(sign.rawPublicKey(first.publicKey).length, 1952);
  assert.equal(sign.rawPublicKey(second.publicKey).length, 1952);
  assert.notEqual(sign.publicKeyHex(first.publicKey), sign.publicKeyHex(second.publicKey));
  const signature = sign.signBytes(first.privateKey, message);
  assert.equal(sign.verifyBytes(sign.publicKeyHex(second.publicKey), message, signature), false);
});

test('an Ed25519 key or signature is not an ML-DSA verification', () => {
  const ed = generateKeyPairSync('ed25519');
  const edPub = ed.publicKey.export({ format: 'der', type: 'spki' }).toString('hex');
  const edSig = nodeSign(null, message, ed.privateKey).toString('hex');
  assert.equal(Buffer.from(edSig, 'hex').length, 64);
  assert.equal(sign.verifyBytes(edPub, message, edSig), false);
  const identity = sign.generateIdentity();
  const mlSig = sign.signBytes(identity.privateKey, message);
  assert.equal(sign.verifyBytes(edPub, message, mlSig), false);
  assert.equal(sign.rawPublicKey(ed.publicKey), null);
  console.log(`ed25519 rejected sig bytes ${Buffer.from(edSig, 'hex').length}`);
});
