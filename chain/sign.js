// FIPS 204 ML-DSA for clawd chain identities. Pure ML-DSA.Sign / ML-DSA.Verify
// (Algorithms 2 and 3), parameter set ML-DSA-65 from Table 1 (category 3).
// Table 2 sizes: public key 1952, signature 3309, expanded private key 4032.
// The stored private key may be the 32-byte seed, which Section 4 allows.
// Hedged signing is the default. The application context is "clawd" (≤ 255 bytes).
// HashML-DSA is not used.
const { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } = require('crypto');

const PARAMETER_SET = 'ml-dsa-65';
const CONTEXT = Buffer.from('clawd');
const SIZES = {
  privateKey: 4032,
  publicKey: 1952,
  signature: 3309,
};

function contextBytes(context) {
  const buf = context == null ? CONTEXT : (Buffer.isBuffer(context) ? context : Buffer.from(context));
  if (buf.length > 255) {
    const error = new Error('context');
    error.code = 'CONTEXT';
    throw error;
  }
  return buf;
}

function generateIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync(PARAMETER_SET);
  return { publicKey, privateKey, parameterSet: PARAMETER_SET };
}

function publicKeyHex(publicKey) {
  return publicKey.export({ format: 'der', type: 'spki' }).toString('hex');
}

function rawPublicKey(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  if (!jwk || jwk.alg !== 'ML-DSA-65' || typeof jwk.pub !== 'string') return null;
  return Buffer.from(jwk.pub, 'base64url');
}

function privateKeyFromHex(hex) {
  return createPrivateKey({ key: Buffer.from(hex, 'hex'), format: 'der', type: 'pkcs8' });
}

function signBytes(privateKey, bytes, context) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const signature = sign(null, data, { key: privateKey, context: contextBytes(context) });
  if (signature.length !== SIZES.signature) {
    const error = new Error('signature');
    error.code = 'SIGNATURE';
    throw error;
  }
  return signature.toString('hex');
}

function verifyBytes(publicHex, bytes, signatureHex, context) {
  if (typeof publicHex !== 'string' || typeof signatureHex !== 'string') return false;
  if (publicHex.length === 0 || signatureHex.length === 0 || signatureHex.length % 2 !== 0) return false;
  let ctx;
  try {
    ctx = contextBytes(context);
  } catch {
    return false;
  }
  const signature = Buffer.from(signatureHex, 'hex');
  // FIPS 204 §3.6.2: a public key or signature of any other length is false.
  if (signature.length !== SIZES.signature) return false;
  try {
    const key = createPublicKey({ key: Buffer.from(publicHex, 'hex'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== PARAMETER_SET) return false;
    const raw = rawPublicKey(key);
    if (!raw || raw.length !== SIZES.publicKey) return false;
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    return verify(null, data, { key, context: ctx }, signature);
  } catch {
    return false;
  }
}

function sha256Hex(bytes) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return createHash('sha256').update(data).digest('hex');
}

module.exports = {
  PARAMETER_SET,
  CONTEXT,
  SIZES,
  generateIdentity,
  publicKeyHex,
  rawPublicKey,
  privateKeyFromHex,
  signBytes,
  verifyBytes,
  sha256Hex,
};
