// Compressed accounts as Merkle leaves. The fingerprint is only the root.
// Inclusion is fail-closed: a wrong leaf, sibling, or root does not verify.
// This is not a Groth16 proof.
const { canonical, sha256 } = require('./codec');

const DEPTH = 8;
const LEAVES = 1 << DEPTH;

function leafHash(bytes) {
  return sha256(Buffer.concat([Buffer.from([0x00]), bytes]));
}

function nodeHash(left, right) {
  return sha256(Buffer.concat([Buffer.from([0x01]), left, right]));
}

function emptyLevels() {
  const levels = [leafHash(Buffer.from('clawd-empty-leaf'))];
  for (let depth = 1; depth <= DEPTH; depth++) {
    levels[depth] = nodeHash(levels[depth - 1], levels[depth - 1]);
  }
  return levels;
}

function createForest() {
  const zeros = emptyLevels();
  return {
    depth: DEPTH,
    zeros,
    leaves: new Array(LEAVES).fill(null),
    next: 0,
    root: zeros[DEPTH],
    accounts: {},
  };
}

function layerOf(forest) {
  const layer = new Array(LEAVES);
  for (let i = 0; i < LEAVES; i++) layer[i] = forest.leaves[i] || forest.zeros[0];
  return layer;
}

function computeRoot(forest) {
  let layer = layerOf(forest);
  while (layer.length > 1) {
    const next = new Array(layer.length / 2);
    for (let i = 0; i < next.length; i++) next[i] = nodeHash(layer[i * 2], layer[i * 2 + 1]);
    layer = next;
  }
  return layer[0];
}

function accountBytes(account) {
  return Buffer.from(canonical({
    address: account.address,
    owner: account.owner,
    data: account.data,
    seq: account.seq,
  }), 'utf8');
}

function exportProof(forest, index) {
  const siblings = [];
  let layer = layerOf(forest);
  let cursor = index;
  for (let depth = 0; depth < DEPTH; depth++) {
    const siblingIndex = cursor ^ 1;
    siblings.push({
      hash: layer[siblingIndex].toString('hex'),
      left: siblingIndex < cursor,
    });
    const next = new Array(layer.length / 2);
    for (let i = 0; i < next.length; i++) next[i] = nodeHash(layer[i * 2], layer[i * 2 + 1]);
    layer = next;
    cursor = Math.floor(cursor / 2);
  }
  return {
    index,
    leaf: forest.leaves[index].toString('hex'),
    siblings,
  };
}

function fingerprint(forest) {
  return { root: forest.root.toString('hex') };
}

function createAccount(forest, { owner, data } = {}) {
  if (!owner) throw new Error('owner');
  if (forest.next >= LEAVES) throw new Error('full');
  const index = forest.next;
  forest.next += 1;
  const address = sha256(Buffer.from('clawd-acct:' + index + ':' + owner)).toString('hex');
  const account = { address, owner: String(owner), data: data == null ? '' : data, seq: 0, index };
  forest.leaves[index] = leafHash(accountBytes(account));
  forest.root = computeRoot(forest);
  forest.accounts[address] = account;
  return { account, fingerprint: fingerprint(forest), proof: exportProof(forest, index) };
}

function verifyInclusion(root, proof) {
  try {
    if (!proof || typeof root !== 'string' || !/^[0-9a-f]+$/i.test(root)) return false;
    if (!Array.isArray(proof.siblings) || proof.siblings.length !== DEPTH) return false;
    if (typeof proof.leaf !== 'string' || proof.leaf.length !== 64) return false;
    let acc = Buffer.from(proof.leaf, 'hex');
    if (acc.length !== 32) return false;
    for (const sibling of proof.siblings) {
      if (!sibling || typeof sibling.hash !== 'string' || sibling.hash.length !== 64) return false;
      const side = Buffer.from(sibling.hash, 'hex');
      if (side.length !== 32) return false;
      acc = sibling.left ? nodeHash(side, acc) : nodeHash(acc, side);
    }
    return acc.toString('hex') === root.toLowerCase();
  } catch {
    return false;
  }
}

function transitionAccount(forest, address, data) {
  const account = forest.accounts[address];
  if (!account) throw new Error('unknown account');
  const previous = exportProof(forest, account.index);
  const previousRoot = fingerprint(forest);
  account.data = data;
  account.seq += 1;
  forest.leaves[account.index] = leafHash(accountBytes(account));
  forest.root = computeRoot(forest);
  return {
    previousRoot,
    previous,
    fingerprint: fingerprint(forest),
    proof: exportProof(forest, account.index),
    account,
  };
}

module.exports = {
  DEPTH,
  createForest,
  createAccount,
  fingerprint,
  verifyInclusion,
  transitionAccount,
};
