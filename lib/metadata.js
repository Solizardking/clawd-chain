// Pure checks for a Metaplex Core asset name and its off-chain metadata document.
const MAX_NFT_NAME = 32;

function asObject(input) {
  if (typeof input === 'string') {
    try { return { ok: true, value: JSON.parse(input) }; } catch { return { ok: false, reason: 'invalid json' }; }
  }
  return { ok: true, value: input };
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateNftName(name) {
  if (typeof name !== 'string') return { ok: false, reason: 'name must be a string' };
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, reason: 'name is required' };
  const chars = Array.from(trimmed).length;
  const bytes = Buffer.byteLength(trimmed);
  if (chars > MAX_NFT_NAME || bytes > MAX_NFT_NAME) {
    return { ok: false, reason: 'name must be at most 32 characters' };
  }
  return { ok: true, name: trimmed };
}

function validateNftMetadata(input) {
  const parsed = asObject(input);
  if (!parsed.ok) return parsed;
  const doc = parsed.value;
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, reason: 'metadata must be an object' };
  }
  const errors = [];
  if (!nonEmpty(doc.name)) errors.push('name is required');
  if (!nonEmpty(doc.description)) errors.push('description is required');
  if (!nonEmpty(doc.image)) errors.push('image is required');
  if (errors.length) return { ok: false, reason: errors.join('; '), errors };
  return {
    ok: true,
    metadata: {
      name: doc.name.trim(),
      description: doc.description.trim(),
      image: doc.image.trim(),
    },
  };
}

function validateNftCreate({ name, uri, metadata } = {}) {
  const nameCheck = validateNftName(name);
  if (!nameCheck.ok) return nameCheck;
  if (typeof uri !== 'string' || !uri.trim()) return { ok: false, reason: 'uri is required' };
  const meta = validateNftMetadata(metadata);
  if (!meta.ok) return meta;
  return { ok: true, name: nameCheck.name, uri: uri.trim(), metadata: meta.metadata };
}

module.exports = {
  MAX_NFT_NAME,
  validateNftName,
  validateNftMetadata,
  validateNftCreate,
};
