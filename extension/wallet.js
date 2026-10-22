// Local-custody Clawd wallet. The seed stays in this context.
(function (root) {
  const RPC = 'https://rpc.clawdchain.trade';
  const FAUCET = 'https://faucet.clawdchain.trade';
  const LAMPORTS = 1000000000n;
  const encoder = new TextEncoder();
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const PKCS8_PREFIX = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
  ]);
  const memory = {};
  const vault = {
    phrase: '',
    privateKey: null,
    publicKey: '',
    address: '',
  };

  function storageArea() {
    if (root.chrome && root.chrome.storage && root.chrome.storage.local) return root.chrome.storage.local;
    return {
      get(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (let i = 0; i < list.length; i++) out[list[i]] = memory[list[i]];
        return Promise.resolve(out);
      },
      set(obj) {
        const keys = Object.keys(obj);
        for (let i = 0; i < keys.length; i++) memory[keys[i]] = obj[keys[i]];
        return Promise.resolve();
      },
    };
  }

  function bytesToHex(bytes) {
    let hex = '';
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
    return hex;
  }

  function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  function base58Encode(bytes) {
    let zeros = 0;
    while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
    const digits = [0];
    for (let i = zeros; i < bytes.length; i++) {
      let carry = bytes[i];
      for (let j = 0; j < digits.length; j++) {
        carry += digits[j] << 8;
        digits[j] = carry % 58;
        carry = (carry / 58) | 0;
      }
      while (carry > 0) {
        digits.push(carry % 58);
        carry = (carry / 58) | 0;
      }
    }
    let out = '';
    for (let i = 0; i < zeros; i++) out += '1';
    for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
    return out;
  }

  function b64urlToBytes(text) {
    const pad = text.length % 4 === 0 ? '' : '='.repeat(4 - (text.length % 4));
    const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + pad;
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function pkcs8FromSeed(seed) {
    const out = new Uint8Array(PKCS8_PREFIX.length + seed.length);
    out.set(PKCS8_PREFIX, 0);
    out.set(seed, PKCS8_PREFIX.length);
    return out;
  }

  function formatClawd(lamports) {
    const n = BigInt(lamports || 0);
    const whole = n / LAMPORTS;
    const frac = (n % LAMPORTS).toString().padStart(9, '0').replace(/0+$/, '');
    return frac ? whole.toString() + '.' + frac : whole.toString();
  }

  async function derive(phrase) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(phrase)));
    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      pkcs8FromSeed(digest),
      { name: 'Ed25519' },
      true,
      ['sign'],
    );
    const jwk = await crypto.subtle.exportKey('jwk', privateKey);
    const raw = b64urlToBytes(jwk.x);
    vault.phrase = phrase;
    vault.privateKey = privateKey;
    vault.publicKey = jwk.x;
    vault.address = base58Encode(raw);
    return { address: vault.address, publicKey: vault.publicKey };
  }

  async function createOrRestore(phrase) {
    let next = phrase;
    if (typeof next !== 'string' || next.length === 0) {
      const stored = await storageArea().get(['clawd.seed']);
      next = stored && stored['clawd.seed'];
    }
    if (typeof next !== 'string' || next.length === 0) {
      const random = new Uint8Array(32);
      crypto.getRandomValues(random);
      next = bytesToHex(random);
    }
    await storageArea().set({ 'clawd.seed': next });
    return derive(next);
  }

  function lock() {
    vault.phrase = '';
    vault.privateKey = null;
    vault.publicKey = '';
    vault.address = '';
  }

  async function rpc(method, params) {
    const response = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const json = await response.json();
    return json.result;
  }

  function accountRows(result) {
    const value = result && result.value ? result.value : [];
    const rows = [];
    for (let i = 0; i < value.length; i++) {
      const info = value[i] && value[i].account && value[i].account.data && value[i].account.data.parsed
        ? value[i].account.data.parsed.info
        : null;
      if (!info || !info.mint) continue;
      const amount = info.tokenAmount && info.tokenAmount.amount != null ? info.tokenAmount.amount : '0';
      rows.push({ mint: info.mint, balance: String(amount) });
    }
    return rows;
  }

  async function listHoldings() {
    const names = root.ClawdNames;
    if (!names) throw new Error('names');
    const owned = await rpc('getTokenAccountsByOwner', [
      vault.address,
      { programId: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' },
      { encoding: 'jsonParsed' },
    ]);
    const rows = accountRows(owned);
    const byMint = {};
    for (let i = 0; i < rows.length; i++) {
      const info = await rpc('getAccountInfo', [rows[i].mint, { encoding: 'jsonParsed' }]);
      byMint[rows[i].mint] = names.parseMintAccount(info);
    }
    return names.resolveHoldings(rows, byMint);
  }

  function renderHoldings(el, holdings) {
    const lines = (holdings || []).map(row => {
      const label = row.name || 'Unnamed';
      return label + ' · ' + row.balance;
    });
    const text = lines.length ? lines.join('\n') : 'No tokens yet';
    if (el) el.textContent = text;
    return text;
  }

  async function refresh() {
    const balance = await rpc('getBalance', [vault.address]);
    const lamports = balance && balance.value ? balance.value : 0;
    const text = formatClawd(lamports) + ' CLAWD';
    const balanceEl = root.document && root.document.getElementById ? root.document.getElementById('balance') : null;
    if (balanceEl) balanceEl.textContent = text;
    const addressEl = root.document && root.document.getElementById ? root.document.getElementById('address') : null;
    if (addressEl) addressEl.textContent = vault.address;
    let holdings = [];
    try { holdings = await listHoldings(); } catch (error) { holdings = []; }
    const holdingsEl = root.document && root.document.getElementById ? root.document.getElementById('holdings') : null;
    renderHoldings(holdingsEl, holdings);
    return { clawd: formatClawd(lamports), text, holdings, address: vault.address };
  }

  async function requestAirdrop() {
    if (!vault.address) throw new Error('locked');
    const pow = root.ClawdPow;
    if (!pow || typeof pow.solve !== 'function') throw new Error('pow');
    const issued = await (await fetch(FAUCET + '/challenge')).json();
    if (!issued || typeof issued.challenge !== 'string') throw new Error('faucet error');
    const solved = await pow.solve(issued.challenge, issued.bits);
    const response = await fetch(FAUCET + '/airdrop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: vault.address, challenge: issued.challenge, nonce: solved.nonce }),
    });
    const body = await response.json();
    if (!body || !body.signature) throw new Error(body && body.error ? body.error : 'faucet error');
    await refresh();
    return body;
  }

  async function buildTransfer({ recipient, amount } = {}) {
    if (!vault.privateKey) throw new Error('locked');
    if (typeof recipient !== 'string' || recipient.trim().length === 0) throw new Error('recipient');
    const sender = vault.address;
    const payload = JSON.stringify({
      sender,
      recipient: recipient.trim(),
      amount: String(amount),
      network: 'clawd',
    });
    const signature = await crypto.subtle.sign({ name: 'Ed25519' }, vault.privateKey, encoder.encode(payload));
    return {
      sender,
      recipient: recipient.trim(),
      amount: String(amount),
      network: 'clawd',
      payload,
      signature: bytesToHex(new Uint8Array(signature)),
      publicKey: vault.publicKey,
    };
  }

  root.ClawdWallet = {
    RPC,
    FAUCET,
    createOrRestore,
    lock,
    refresh,
    listHoldings,
    renderHoldings,
    buildTransfer,
    requestAirdrop,
    formatClawd,
    getAddress() { return vault.address; },
    getPublicKey() { return vault.publicKey; },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
