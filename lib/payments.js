// Pure x402 / MPP payment rules for clawd. No RPC and no balance writes.
const { PublicKey, SystemProgram, Transaction } = require('@solana/web3.js');

const NETWORK = 'clawd';
const PROTECTED_RESOURCE = 'CLAWD_PROTECTED_RESOURCE';
const EXACT_SCHEMES = new Set(['exact', 'x402']);
const SCHEMES = new Set(['exact', 'x402', 'mpp']);

class PaymentError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'PaymentError';
    this.reason = reason;
  }
}

function supportedKinds() {
  return {
    kinds: [
      { scheme: 'exact', network: NETWORK },
      { scheme: 'x402', network: NETWORK },
      { scheme: 'mpp', network: NETWORK },
    ],
  };
}

const U64_MAX = 18446744073709551615n;

function normalizeAmount(amount) {
  let n = null;
  if (typeof amount === 'bigint') n = amount;
  else if (typeof amount === 'number') {
    if (!Number.isSafeInteger(amount)) return null;
    n = BigInt(amount);
  } else if (typeof amount === 'string' && /^[0-9]+$/.test(amount)) {
    try { n = BigInt(amount); } catch { return null; }
  }
  if (n == null || n <= 0n || n > U64_MAX) return null;
  return n.toString();
}

function normalizeAddress(address) {
  try {
    return new PublicKey(address).toBase58();
  } catch {
    return null;
  }
}

function sameScheme(a, b) {
  if (a === b) return true;
  return EXACT_SCHEMES.has(a) && EXACT_SCHEMES.has(b);
}

// Stated recipient amounts. Duplicates and non-positive amounts are rejected.
function quoteSplit(recipients) {
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return { ok: false, reason: 'missing recipients' };
  }
  const parts = [];
  const seen = new Set();
  for (const row of recipients) {
    const address = normalizeAddress(row && row.address || row && row.payTo);
    const amount = normalizeAmount(row && (row.amount != null ? row.amount : row.lamports));
    if (!address) return { ok: false, reason: 'invalid recipient' };
    if (!amount) return { ok: false, reason: 'invalid amount' };
    if (seen.has(address)) return { ok: false, reason: 'duplicate recipient' };
    seen.add(address);
    parts.push({ address, amount });
  }
  const total = parts.reduce((sum, part) => sum + BigInt(part.amount), 0n).toString();
  return { ok: true, total, recipients: parts };
}

function buildChallenge(opts = {}) {
  const scheme = opts.scheme || 'exact';
  if (!SCHEMES.has(scheme)) throw new PaymentError('unsupported scheme');
  const feePayer = normalizeAddress(opts.feePayer);
  if (!feePayer) throw new PaymentError('missing fee payer');
  const nonce = opts.nonce != null ? String(opts.nonce) : require('crypto').randomBytes(16).toString('hex');
  if (!nonce || nonce.length > 128) throw new PaymentError('missing nonce');
  let recipients;
  if (scheme === 'mpp') {
    const quoted = quoteSplit(opts.recipients);
    if (!quoted.ok) throw new PaymentError(quoted.reason);
    if (quoted.recipients.length < 2) throw new PaymentError('mpp requires two recipients');
    recipients = quoted.recipients;
  } else {
    const payTo = normalizeAddress(opts.payTo);
    const amount = normalizeAmount(opts.amount);
    if (!payTo) throw new PaymentError('missing payTo');
    if (!amount) throw new PaymentError('invalid amount');
    recipients = [{ address: payTo, amount }];
  }
  const amount = recipients.reduce((sum, part) => sum + BigInt(part.amount), 0n).toString();
  const payTo = opts.payTo ? normalizeAddress(opts.payTo) : recipients[0].address;
  if (!payTo) throw new PaymentError('missing payTo');
  if (scheme !== 'mpp' && payTo !== recipients[0].address) throw new PaymentError('missing payTo');
  const asset = opts.asset || 'native';
  if (asset !== 'native' && asset !== 'CLAWD') throw new PaymentError('unsupported asset');
  const resource = opts.resource != null ? String(opts.resource) : '/resource';
  const challenge = {
    x402Version: 1,
    scheme,
    network: NETWORK,
    amount,
    maxAmountRequired: amount,
    payTo,
    asset,
    resource,
    nonce,
    feePayer,
    recipients,
    extra: { feePayer, nonce, splits: recipients },
    accepts: [{
      scheme,
      network: NETWORK,
      maxAmountRequired: amount,
      resource,
      description: opts.description || 'clawd chain payment',
      mimeType: opts.mimeType || 'application/json',
      payTo,
      maxTimeoutSeconds: opts.maxTimeoutSeconds || 60,
      asset,
      extra: { feePayer, nonce, splits: recipients },
    }],
  };
  if (JSON.stringify(challenge).includes(PROTECTED_RESOURCE)) {
    throw new PaymentError('challenge must not contain the protected resource');
  }
  return challenge;
}

function parseChallenge(input) {
  let value = input;
  if (typeof input === 'string') {
    try { value = JSON.parse(input); } catch { return { ok: false, reason: 'invalid challenge' }; }
  }
  if (!value || typeof value !== 'object') return { ok: false, reason: 'invalid challenge' };
  const accept = Array.isArray(value.accepts) && value.accepts[0] ? value.accepts[0] : value;
  const scheme = accept.scheme || value.scheme;
  const network = accept.network || value.network;
  const extra = accept.extra || value.extra || {};
  const nonce = value.nonce || extra.nonce;
  const feePayer = normalizeAddress(value.feePayer || extra.feePayer);
  const payTo = normalizeAddress(accept.payTo || value.payTo);
  const asset = accept.asset || value.asset || 'native';
  if (!SCHEMES.has(scheme)) return { ok: false, reason: 'unsupported scheme' };
  if (network !== NETWORK) return { ok: false, reason: 'unsupported network' };
  if (!nonce || String(nonce).length > 128) return { ok: false, reason: 'missing nonce' };
  if (!feePayer) return { ok: false, reason: 'missing fee payer' };
  if (asset !== 'native' && asset !== 'CLAWD') return { ok: false, reason: 'unsupported asset' };
  let listed = value.recipients || extra.splits;
  if (!listed && payTo) {
    const only = normalizeAmount(accept.maxAmountRequired || accept.amount || value.amount || value.maxAmountRequired);
    if (!only) return { ok: false, reason: 'invalid amount' };
    listed = [{ address: payTo, amount: only }];
  }
  const quoted = quoteSplit(listed || []);
  if (!quoted.ok) return quoted;
  if (scheme === 'mpp' && quoted.recipients.length < 2) return { ok: false, reason: 'mpp requires two recipients' };
  if (scheme !== 'mpp' && quoted.recipients.length !== 1) return { ok: false, reason: 'payment does not match the challenge' };
  const amount = quoted.total;
  const resolvedPayTo = payTo || quoted.recipients[0].address;
  if (scheme !== 'mpp' && resolvedPayTo !== quoted.recipients[0].address) {
    return { ok: false, reason: 'payment does not match the challenge' };
  }
  return {
    ok: true,
    challenge: {
      x402Version: 1,
      scheme,
      network,
      amount,
      maxAmountRequired: amount,
      payTo: resolvedPayTo,
      asset,
      resource: accept.resource || value.resource || '',
      nonce: String(nonce),
      feePayer,
      recipients: quoted.recipients,
      extra: { feePayer, nonce: String(nonce), splits: quoted.recipients },
      accepts: [{
        scheme,
        network,
        maxAmountRequired: amount,
        resource: accept.resource || value.resource || '',
        description: accept.description || 'clawd chain payment',
        mimeType: accept.mimeType || 'application/json',
        payTo: resolvedPayTo,
        maxTimeoutSeconds: accept.maxTimeoutSeconds || 60,
        asset,
        extra: { feePayer, nonce: String(nonce), splits: quoted.recipients },
      }],
    },
  };
}

function unpaidHttp(challenge) {
  const parsed = challenge && challenge.accepts ? { ok: true, challenge } : parseChallenge(challenge);
  if (!parsed.ok) return { status: 402, headers: { 'content-type': 'application/json' }, body: { x402Version: 1, error: parsed.reason, network: NETWORK } };
  const c = parsed.challenge;
  const body = {
    x402Version: 1,
    error: 'X-PAYMENT header is required',
    scheme: c.scheme,
    network: c.network,
    amount: c.amount,
    payTo: c.payTo,
    nonce: c.nonce,
    asset: c.asset,
    feePayer: c.feePayer,
    recipients: c.recipients,
    accepts: c.accepts,
  };
  return {
    status: 402,
    headers: {
      'content-type': 'application/json',
      'www-authenticate': `Payment scheme="${c.scheme}" network="${NETWORK}"`,
      'access-control-allow-origin': '*',
      'access-control-expose-headers': 'www-authenticate, x-payment-response, payment-response',
    },
    body,
  };
}

function buildPayment({ challenge, transaction }) {
  const parsed = challenge && challenge.nonce ? { ok: true, challenge } : parseChallenge(challenge);
  if (!parsed.ok) throw new PaymentError(parsed.reason);
  const c = parsed.challenge;
  const raw = Buffer.isBuffer(transaction) ? transaction : Buffer.from(transaction);
  return {
    x402Version: 1,
    scheme: c.scheme,
    network: c.network,
    nonce: c.nonce,
    payload: { transaction: raw.toString('base64') },
  };
}

function encodePaymentHeader(payment) {
  return Buffer.from(JSON.stringify(payment)).toString('base64');
}

function parsePayment(raw) {
  if (raw && typeof raw === 'object' && raw.payload && raw.payload.transaction) {
    return { ok: true, payment: raw };
  }
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'invalid payment' };
  const trimmed = raw.trim();
  try {
    const json = trimmed.startsWith('{') ? trimmed : Buffer.from(trimmed, 'base64').toString('utf8');
    const payment = JSON.parse(json);
    if (!payment || !payment.payload || typeof payment.payload.transaction !== 'string') {
      return { ok: false, reason: 'invalid payment' };
    }
    return { ok: true, payment };
  } catch {
    return { ok: false, reason: 'invalid payment' };
  }
}

function readPaymentHeader(headers) {
  const lower = {};
  for (const [key, value] of Object.entries(headers || {})) lower[String(key).toLowerCase()] = value;
  const raw = lower['x-payment'] || lower['payment-signature'];
  if (!raw) return { ok: false, reason: 'missing payment' };
  return parsePayment(Array.isArray(raw) ? raw[0] : raw);
}

function readSystemTransfer(ix) {
  if (!ix.programId.equals(SystemProgram.programId)) return null;
  const data = Buffer.from(ix.data);
  if (data.length < 12 || data.readUInt32LE(0) !== 2) return null;
  return {
    from: ix.keys[0].pubkey.toBase58(),
    to: ix.keys[1].pubkey.toBase58(),
    lamports: data.readBigUInt64LE(4),
  };
}

function decodeProofTransaction(raw) {
  let buf;
  try {
    buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'base64');
  } catch {
    return { ok: false, reason: 'invalid transaction' };
  }
  let tx;
  try { tx = Transaction.from(buf); } catch { return { ok: false, reason: 'invalid transaction' }; }
  if (!tx.instructions.length) return { ok: false, reason: 'missing transfer' };
  const transfers = [];
  for (const ix of tx.instructions) {
    const row = readSystemTransfer(ix);
    if (!row) return { ok: false, reason: 'only native CLAWD transfers are accepted' };
    transfers.push(row);
  }
  const payer = transfers[0].from;
  if (transfers.some(row => row.from !== payer)) return { ok: false, reason: 'transfers must share one payer' };
  const feePayer = tx.feePayer ? tx.feePayer.toBase58() : null;
  if (!feePayer) return { ok: false, reason: 'missing fee payer' };
  const payerSig = tx.signatures.find(sig => sig.publicKey.toBase58() === payer);
  const facilitatorSig = tx.signatures.find(sig => sig.publicKey.toBase58() === feePayer);
  const signed = Boolean(payerSig && payerSig.signature !== null);
  let signatureOk = false;
  if (signed) {
    try { signatureOk = tx.verifySignatures(false); } catch { signatureOk = false; }
  }
  return {
    ok: true,
    feePayer,
    payer,
    transfers,
    facilitatorSigned: Boolean(facilitatorSig && facilitatorSig.signature !== null),
    payerSigned: signed && signatureOk,
    payerSignature: signed ? Buffer.from(payerSig.signature).toString('base64') : null,
  };
}

function createSeenPayments() {
  const nonces = new Set();
  const signatures = new Set();
  return {
    has(nonce, signature) {
      return Boolean((nonce && nonces.has(nonce)) || (signature && signatures.has(signature)));
    },
    add(nonce, signature) {
      if (nonce) nonces.add(nonce);
      if (signature) signatures.add(signature);
    },
    release(nonce, signature) {
      if (nonce) nonces.delete(nonce);
      if (signature) signatures.delete(signature);
    },
    get size() { return nonces.size + signatures.size; },
  };
}

function matchesChallenge(challenge, decoded) {
  const expected = challenge.recipients;
  if (decoded.transfers.length !== expected.length) return false;
  const used = new Set();
  for (const part of expected) {
    const idx = decoded.transfers.findIndex((row, i) => {
      return !used.has(i) && row.to === part.address && row.lamports === BigInt(part.amount);
    });
    if (idx < 0) return false;
    used.add(idx);
  }
  return true;
}

function verifyPayment({ challenge, payment, seen, balances } = {}) {
  const before = balances && typeof balances === 'object' ? JSON.stringify(balances) : null;
  const fail = (reason, extra = {}) => {
    if (before != null && JSON.stringify(balances) !== before) {
      throw new PaymentError('verify mutated balances');
    }
    return { ok: false, reason, movesFunds: false, submit: false, release: false, ...extra };
  };
  const parsedChallenge = challenge && challenge.recipients ? { ok: true, challenge } : parseChallenge(challenge);
  if (!parsedChallenge.ok) return fail(parsedChallenge.reason);
  const c = parsedChallenge.challenge;
  const parsedPayment = parsePayment(payment);
  if (!parsedPayment.ok) return fail(parsedPayment.reason);
  const p = parsedPayment.payment;
  if (!sameScheme(p.scheme, c.scheme)) return fail('scheme mismatch');
  if (p.network !== NETWORK) return fail('network mismatch');
  if (String(p.nonce || '') !== c.nonce) return fail('nonce mismatch');
  const decoded = decodeProofTransaction(p.payload.transaction);
  if (!decoded.ok) return fail(decoded.reason);
  if (decoded.feePayer !== c.feePayer) return fail('fee payer must be the facilitator');
  if (decoded.feePayer === decoded.payer) return fail('fee payer must be distinct from the paying wallet');
  if (!decoded.payerSigned) return fail(decoded.payerSignature ? 'bad signature' : 'payer signature required');
  if (!matchesChallenge(c, decoded)) return fail('payment does not match the challenge');
  if (seen && typeof seen.has === 'function' && seen.has(c.nonce, decoded.payerSignature)) {
    return fail('replayed proof', { nonce: c.nonce, payerSignature: decoded.payerSignature });
  }
  if (before != null && JSON.stringify(balances) !== before) throw new PaymentError('verify mutated balances');
  const split = decoded.transfers.map(row => ({ address: row.to, amount: row.lamports.toString() }));
  return {
    ok: true,
    reason: null,
    movesFunds: false,
    submit: false,
    release: false,
    scheme: c.scheme,
    network: NETWORK,
    nonce: c.nonce,
    amount: c.amount,
    payTo: c.payTo,
    feePayer: decoded.feePayer,
    payer: decoded.payer,
    facilitatorSigned: decoded.facilitatorSigned,
    payerSignature: decoded.payerSignature,
    split,
    transfers: decoded.transfers.map(row => ({ from: row.from, to: row.to, lamports: row.lamports.toString() })),
  };
}

function settleIntent(input) {
  const verdict = verifyPayment(input);
  if (!verdict.ok) return verdict;
  return { ...verdict, submit: true, release: true, movesFunds: false };
}

function paymentResponseBody(verdict) {
  return {
    success: true,
    scheme: verdict.scheme,
    network: verdict.network,
    payer: verdict.payer,
    feePayer: verdict.feePayer,
    amount: verdict.amount,
    split: verdict.split,
  };
}

function decideAccess({ challenge, payment, seen, resource } = {}) {
  const verdict = verifyPayment({ challenge, payment, seen });
  if (!verdict.ok) {
    const http = unpaidHttp(challenge);
    return { ...http, released: false, reason: verdict.reason, verdict };
  }
  const response = paymentResponseBody(verdict);
  const encoded = encodePaymentHeader(response);
  return {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'x-payment-response': encoded,
      'payment-response': encoded,
      'access-control-allow-origin': '*',
      'access-control-expose-headers': 'x-payment-response, payment-response',
    },
    body: resource,
    released: true,
    reason: null,
    verdict,
    paymentResponse: response,
  };
}

// Pure ledger math for a verified transfer list. Does not mutate `balances`.
function applyTransferAccounting(balances, transfers) {
  const next = { ...balances };
  for (const row of transfers) {
    const amt = BigInt(row.lamports);
    const fromKey = row.from;
    const toKey = row.to;
    const from = BigInt(next[fromKey] ?? '0');
    if (from < amt) return { ok: false, reason: 'insufficient funds', balances };
    const to = BigInt(next[toKey] ?? '0');
    next[fromKey] = (from - amt).toString();
    next[toKey] = (to + amt).toString();
  }
  return { ok: true, balances: next };
}

module.exports = {
  NETWORK,
  PROTECTED_RESOURCE,
  PaymentError,
  supportedKinds,
  normalizeAmount,
  quoteSplit,
  buildChallenge,
  parseChallenge,
  unpaidHttp,
  buildPayment,
  encodePaymentHeader,
  parsePayment,
  readPaymentHeader,
  decodeProofTransaction,
  createSeenPayments,
  verifyPayment,
  settleIntent,
  paymentResponseBody,
  decideAccess,
  applyTransferAccounting,
};
