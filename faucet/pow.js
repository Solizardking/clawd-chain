// Proof-of-work hasher for the clawd faucet. Classic script and Node.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ClawdPow = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  function rotr(x, n) {
    return (x >>> n) | (x << (32 - n));
  }

  function sha256(message) {
    const bytes = typeof message === 'string' ? new TextEncoder().encode(message) : message;
    const len = bytes.length;
    const bitLen = len * 8;
    const zeroPad = (56 - ((len + 1) % 64) + 64) % 64;
    const total = len + 1 + zeroPad + 8;
    const buf = new Uint8Array(total);
    buf.set(bytes, 0);
    buf[len] = 0x80;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const high = Math.floor(bitLen / 0x100000000);
    view.setUint32(total - 8, high, false);
    view.setUint32(total - 4, bitLen >>> 0, false);

    let h0 = 0x6a09e667;
    let h1 = 0xbb67ae85;
    let h2 = 0x3c6ef372;
    let h3 = 0xa54ff53a;
    let h4 = 0x510e527f;
    let h5 = 0x9b05688c;
    let h6 = 0x1f83d9ab;
    let h7 = 0x5be0cd19;
    const w = new Uint32Array(64);

    for (let offset = 0; offset < total; offset += 64) {
      for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
      for (let i = 16; i < 64; i++) {
        const x = w[i - 15];
        const y = w[i - 2];
        const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
        const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0;
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let a = h0;
      let b = h1;
      let c = h2;
      let d = h3;
      let e = h4;
      let f = h5;
      let g = h6;
      let h = h7;
      for (let i = 0; i < 64; i++) {
        const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
        const ch = ((e & f) ^ (~e & g)) >>> 0;
        const temp1 = (h + s1 + ch + K[i] + w[i]) >>> 0;
        const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
        const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
        const temp2 = (s0 + maj) >>> 0;
        h = g;
        g = f;
        f = e;
        e = (d + temp1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) >>> 0;
      }
      h0 = (h0 + a) >>> 0;
      h1 = (h1 + b) >>> 0;
      h2 = (h2 + c) >>> 0;
      h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0;
      h5 = (h5 + f) >>> 0;
      h6 = (h6 + g) >>> 0;
      h7 = (h7 + h) >>> 0;
    }

    const out = new Uint8Array(32);
    const packed = new DataView(out.buffer);
    packed.setUint32(0, h0, false);
    packed.setUint32(4, h1, false);
    packed.setUint32(8, h2, false);
    packed.setUint32(12, h3, false);
    packed.setUint32(16, h4, false);
    packed.setUint32(20, h5, false);
    packed.setUint32(24, h6, false);
    packed.setUint32(28, h7, false);
    return out;
  }

  function leadingZeros(bytes) {
    let n = 0;
    for (let i = 0; i < bytes.length; i++) {
      const x = bytes[i];
      if (x === 0) { n += 8; continue; }
      n += Math.clz32(x) - 24;
      break;
    }
    return n;
  }

  async function solve(challenge, bits, hooks) {
    const every = hooks && hooks.every ? hooks.every | 0 : 4096;
    const onStep = hooks && hooks.onStep;
    const target = bits | 0;
    const prefix = String(challenge) + ':';
    let nonce = 0;
    let best = 0;
    let hash;
    while (true) {
      const end = nonce + every;
      for (; nonce < end; nonce++) {
        hash = sha256(prefix + nonce);
        const zeros = leadingZeros(hash);
        if (zeros > best) best = zeros;
        if (zeros >= target) return { nonce, hash, best };
      }
      if (onStep) onStep({ nonce, hash, best });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  return { sha256, leadingZeros, solve };
});
