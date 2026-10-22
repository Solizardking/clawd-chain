// Canonical bytes and sha256 for Clawd proofs, content ids, and signed logs.
const { createHash } = require('crypto');

function canonical(value) {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('canonical number');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (Array.isArray(value)) return '[' + value.map(item => canonical(item)).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  throw new Error('canonical type');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest();
}

function sha256Hex(bytes) {
  return sha256(bytes).toString('hex');
}

module.exports = { canonical, sha256, sha256Hex };
