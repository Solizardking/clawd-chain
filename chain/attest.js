// SVM TEE quote check. Trust is the pinned measurement and the quote signature.
const { canonical } = require('./codec');
const { publicKeyHex, signBytes, verifyBytes } = require('./sign');

function signAttestation(identity, { measurement, nonce, svm = 'clawd', report = '' } = {}) {
  if (typeof measurement !== 'string' || measurement.length === 0) throw new Error('measurement');
  if (typeof nonce !== 'string' || nonce.length === 0) throw new Error('nonce');
  const fields = { measurement, nonce, svm, report };
  const body = canonical(fields);
  const signature = signBytes(identity.privateKey, Buffer.from(body, 'utf8'));
  return {
    measurement,
    nonce,
    svm,
    report,
    body,
    signature,
    publicKey: publicKeyHex(identity.publicKey),
  };
}

function verifyAttestation(attestation, { measurement, signer, seen } = {}) {
  if (!attestation || typeof attestation.body !== 'string' || typeof attestation.signature !== 'string') {
    return { ok: false, reason: 'bad signature' };
  }
  if (signer && attestation.publicKey !== signer) return { ok: false, reason: 'bad signature' };
  const signed = verifyBytes(attestation.publicKey, Buffer.from(attestation.body, 'utf8'), attestation.signature);
  if (!signed) return { ok: false, reason: 'bad signature' };
  let fields;
  try { fields = JSON.parse(attestation.body); } catch { return { ok: false, reason: 'bad signature' }; }
  if (!fields || fields.measurement !== attestation.measurement || fields.nonce !== attestation.nonce) {
    return { ok: false, reason: 'bad signature' };
  }
  if (fields.svm !== 'clawd') return { ok: false, reason: 'svm' };
  if (fields.measurement !== measurement) return { ok: false, reason: 'wrong measurement' };
  if (!seen || typeof seen.has !== 'function') return { ok: false, reason: 'nonce' };
  if (seen.has(fields.nonce)) return { ok: false, reason: 'replayed nonce' };
  seen.add(fields.nonce);
  return { ok: true, reason: 'accepted' };
}

module.exports = { signAttestation, verifyAttestation };
