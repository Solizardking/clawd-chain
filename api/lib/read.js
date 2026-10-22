// Dependency-free account reads for Core NFTs, SPL mints, and agent identities.
const { PROGRAMS, PROGRAM_NAMES } = require('./programs');

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  const digits = [0];
  for (let i = zeros; i < bytes.length; i += 1) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i -= 1) out += ALPHABET[digits[i]];
  return out;
}

function readString(buf, offset) {
  if (offset + 4 > buf.length) return null;
  const len = buf.readUInt32LE(offset);
  const next = offset + 4 + len;
  if (len > 512 || next > buf.length) return null;
  return { text: buf.subarray(offset + 4, next).toString('utf8'), next };
}

function decodeCoreAsset(buf) {
  if (buf.length < 34 || buf[0] !== 1) return null;
  const owner = base58(buf.subarray(1, 33));
  const disc = buf[33];
  let cursor = 34;
  let updateAuthority = null;
  if (disc === 1 || disc === 2) {
    if (buf.length < 66) return null;
    updateAuthority = base58(buf.subarray(34, 66));
    cursor = 66;
  } else if (disc !== 0) return null;
  const name = readString(buf, cursor);
  if (!name) return null;
  const uri = readString(buf, name.next);
  if (!uri) return null;
  return { kind: 'nft', owner, updateAuthority, name: name.text, uri: uri.text };
}

function decodeAgentIdentity(buf) {
  if (buf.length < 104) return null;
  const token = buf.subarray(40, 72);
  const empty = token.every(byte => byte === 0);
  return {
    kind: 'agent',
    asset: base58(buf.subarray(8, 40)),
    agentToken: empty ? null : base58(token),
  };
}

function tokenMetadata(tlv) {
  let index = 0;
  while (index + 4 <= tlv.length) {
    const type = tlv.readUInt16LE(index);
    const len = tlv.readUInt16LE(index + 2);
    const start = index + 4;
    if (start + len > tlv.length) return null;
    if (type === 19 && len >= 64) {
      const name = readString(tlv, start + 64);
      const symbol = name && readString(tlv, name.next);
      const uri = symbol && readString(tlv, symbol.next);
      if (name && symbol) return { name: name.text, symbol: symbol.text, uri: uri ? uri.text : '' };
    }
    index = start + len;
  }
  return null;
}

function decodeToken(owner, buf) {
  const tokenProgram = owner === PROGRAMS.token || owner === PROGRAMS.token2022;
  if (!tokenProgram || buf.length < 82) return null;
  if (buf.length === 165 || (buf.length > 165 && buf[165] === 2)) {
    return {
      kind: 'token-account',
      mint: base58(buf.subarray(0, 32)),
      owner: base58(buf.subarray(32, 64)),
      amount: buf.readBigUInt64LE(64).toString(),
    };
  }
  const mint = buf.length === 82 || (buf.length > 165 && buf[165] === 1);
  if (!mint || buf[45] !== 1) return null;
  const decoded = {
    kind: 'token',
    supply: buf.readBigUInt64LE(36).toString(),
    decimals: buf[44],
  };
  if (buf.length > 166 && buf[165] === 1) Object.assign(decoded, tokenMetadata(buf.subarray(166)) || {});
  return decoded;
}

function decodeAccount(owner, data) {
  if (owner === PROGRAMS.core) return decodeCoreAsset(data);
  if (owner === PROGRAMS.agentIdentity) return decodeAgentIdentity(data);
  return decodeToken(owner, data);
}

function describeAccount(address, info) {
  const value = info && info.value;
  if (!value) return { address, exists: false };
  const data = Buffer.from(value.data[0], 'base64');
  const decoded = decodeAccount(value.owner, data) || {};
  return {
    address,
    exists: true,
    owner: value.owner,
    program: PROGRAM_NAMES[value.owner] || 'other',
    lamports: value.lamports,
    dataSize: data.length,
    ...decoded,
  };
}

module.exports = { base58, decodeAccount, describeAccount, PROGRAMS };
