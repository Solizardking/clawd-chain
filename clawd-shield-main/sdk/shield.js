// clawd shield client SDK (testnet, unaudited). Works in node; browser build bundles same logic.
const { buildPoseidon } = require('circomlibjs');
const snarkjs = require('snarkjs');
const nacl = require('tweetnacl');
const crypto = require('crypto');
const { PublicKey } = require('@solana/web3.js');

const FR = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const FQ = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const LEVELS = 20, ASSET_ID = 1n;
let P; async function init() { if (!P) P = await buildPoseidon(); return P; }
const H = (...xs) => P.F.toObject(P(xs.map(BigInt)));
const rnd = () => BigInt('0x' + crypto.randomBytes(31).toString('hex'));
const be32 = (x) => Buffer.from(BigInt(x).toString(16).padStart(64, '0'), 'hex');
const fromBe = (b) => BigInt('0x' + Buffer.from(b).toString('hex'));

class Keypair {
  constructor(priv) { this.priv = priv ?? rnd(); this.pub = H(this.priv);
    // encryption key derived from shielded key (X25519)
    const seed = crypto.createHash('sha256').update('clawd-shield-enc').update(be32(this.priv)).digest();
    this.enc = nacl.box.keyPair.fromSecretKey(seed); }
  address() { return be32(this.pub).toString('hex') + Buffer.from(this.enc.publicKey).toString('hex'); }
  static fromAddress(a) { return { pub: BigInt('0x' + a.slice(0, 64)), encPub: Buffer.from(a.slice(64), 'hex') }; }
}

class Note {
  constructor({ amount = 0n, pub, keypair, blinding, index }) {
    this.amount = BigInt(amount); this.keypair = keypair; this.pub = keypair ? keypair.pub : pub;
    this.blinding = blinding ?? rnd(); this.index = index;
  }
  commitment() { return H(this.amount, this.pub, this.blinding, ASSET_ID); }
  nullifier() {
    const cm = this.commitment(), idx = BigInt(this.index ?? 0);
    const sig = H(this.keypair.priv, cm, idx);
    return H(cm, idx, sig);
  }
  encrypt(encPub) { // 8 amount + 31 blinding
    const msg = Buffer.concat([be32(this.amount).subarray(24), be32(this.blinding).subarray(1)]);
    const eph = nacl.box.keyPair(); const nonce = crypto.randomBytes(24);
    const box = nacl.box(msg, nonce, encPub, eph.secretKey);
    return Buffer.concat([Buffer.from(eph.publicKey), nonce, Buffer.from(box)]); // 32+24+55 = 111
  }
  static decrypt(keypair, data, index) {
    data = Buffer.from(data);
    const m = nacl.box.open(data.subarray(56), data.subarray(32, 56), data.subarray(0, 32), keypair.enc.secretKey);
    if (!m) return null;
    const b = Buffer.from(m);
    return new Note({ amount: fromBe(b.subarray(0, 8)), blinding: fromBe(b.subarray(8)), keypair, index });
  }
}

class MerkleTree {
  constructor(levels = LEVELS) { this.levels = levels; this.zeros = [0n];
    for (let i = 0; i < levels; i++) this.zeros.push(H(this.zeros[i], this.zeros[i]));
    this.layers = [[]]; for (let i = 1; i <= levels; i++) this.layers.push([]); }
  insert(leaf) { const idx = this.layers[0].length; this.layers[0].push(BigInt(leaf));
    let i = idx; for (let l = 1; l <= this.levels; l++) { i >>= 1;
      const L = this.layers[l - 1][2 * i] ?? this.zeros[l - 1], R = this.layers[l - 1][2 * i + 1] ?? this.zeros[l - 1];
      this.layers[l][i] = H(L, R); } }
  root() { return this.layers[this.levels][0] ?? this.zeros[this.levels]; }
  path(idx) { const els = []; let i = idx;
    for (let l = 0; l < this.levels; l++) { els.push(this.layers[l][i ^ 1] ?? this.zeros[l]); i >>= 1; }
    return els; }
  indexOf(cm) { return this.layers[0].findIndex((x) => x === BigInt(cm)); }
}

function extDataHash({ recipient, relayer, extAmount, fee, enc1, enc2 }) {
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const i64 = Buffer.alloc(8); i64.writeBigInt64LE(BigInt(extAmount));
  const u64 = Buffer.alloc(8); u64.writeBigUInt64LE(BigInt(fee));
  const h = crypto.createHash('sha256').update(Buffer.concat([
    new PublicKey(recipient).toBuffer(), new PublicKey(relayer).toBuffer(), i64, u64, u32(enc1.length), enc1, u32(enc2.length), enc2,
  ])).digest(); h[0] = 0; return fromBe(h);
}
const fieldOf = (v) => ((BigInt(v) % FR) + FR) % FR;

// Build a 2-in/2-out proof. inputs: Note[] (padded with zero notes), outputs: Note[] (2)
async function prove({ tree, inputs, outputs, extAmount, fee, recipient, relayer, encPubs, wasm, zkey }) {
  await init();
  while (inputs.length < 2) inputs.push(new Note({ amount: 0n, keypair: new Keypair() }));
  for (const n of inputs) if (n.amount > 0n) { const i = tree.indexOf(n.commitment()); if (i < 0) throw new Error('note not in tree'); n.index = i; }
  const enc1 = outputs[0].encrypt(encPubs[0]), enc2 = outputs[1].encrypt(encPubs[1]);
  const ext = { recipient, relayer, extAmount: BigInt(extAmount), fee: BigInt(fee), enc1, enc2 };
  const input = {
    root: tree.root(), publicAmount: fieldOf(BigInt(extAmount) - BigInt(fee)), extDataHash: extDataHash(ext),
    inputNullifier: inputs.map((n) => n.nullifier()), outputCommitment: outputs.map((n) => n.commitment()), assetId: ASSET_ID,
    inAmount: inputs.map((n) => n.amount), inPrivateKey: inputs.map((n) => n.keypair.priv), inBlinding: inputs.map((n) => n.blinding),
    inPathIndices: inputs.map((n) => BigInt(n.index ?? 0)),
    inPathElements: inputs.map((n) => (n.amount > 0n ? tree.path(n.index) : new Array(LEVELS).fill(0n))),
    outAmount: outputs.map((n) => n.amount), outPubkey: outputs.map((n) => n.pub), outBlinding: outputs.map((n) => n.blinding),
  };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey);
  return { proof, publicSignals, input, ext, proofBytes: proofToBytes(proof) };
}

function proofToBytes(p) {
  const a = Buffer.concat([be32(p.pi_a[0]), be32(p.pi_a[1])]); // program negates A
  const b = Buffer.concat([be32(p.pi_b[0][1]), be32(p.pi_b[0][0]), be32(p.pi_b[1][1]), be32(p.pi_b[1][0])]);
  const c = Buffer.concat([be32(p.pi_c[0]), be32(p.pi_c[1])]);
  return { a: [...a], b: [...b], c: [...c] };
}

module.exports = { init, H, Keypair, Note, MerkleTree, extDataHash, prove, proofToBytes, be32, fromBe, fieldOf, FR, FQ, LEVELS, ASSET_ID };
