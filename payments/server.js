// Clawd x402 facilitator and one protected resource.
// Verify never submits. Settle co-signs the client transfer and pays the network fee.
const http = require('http');
const bs58 = require('bs58');
const { Connection, Keypair, PublicKey, Transaction } = require('@solana/web3.js');
const pay = require('../lib/payments');
const { createRegistry } = require('./registry');
const fs = require('fs');
const path = require('path');

const PAGE_PATH = path.join(__dirname, 'public', 'index.html');

const DEFAULT_AMOUNT = 1_000_000;
const DEFAULT_SPLIT = [1_000_000, 1_000_000];

function loadKeypair(value) {
  if (!value) return Keypair.generate();
  if (typeof value === 'object' && value.secretKey) return value;
  const { readFileSync } = require('fs');
  const secret = JSON.parse(readFileSync(value, 'utf8'));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function asPublicKey(value) {
  if (!value) return Keypair.generate().publicKey;
  if (value instanceof PublicKey) return value;
  if (value.publicKey) return value.publicKey;
  return new PublicKey(value);
}

function createPaymentsServer(opts = {}) {
  const rpc = opts.rpc || process.env.CLAWD_RPC || 'http://95.216.154.157:8080';
  const connection = opts.connection || new Connection(rpc, 'confirmed');
  const facilitator = loadKeypair(opts.facilitator || process.env.FACILITATOR_KEYPAIR);
  const payTo = asPublicKey(opts.payTo);
  const payeeA = asPublicKey(opts.payeeA);
  const payeeB = asPublicKey(opts.payeeB);
  let exactAmount = String(opts.amount || process.env.PAY_LAMPORTS || DEFAULT_AMOUNT);
  let splits = (opts.splitAmounts || DEFAULT_SPLIT).map(String);
  const seen = pay.createSeenPayments();
  const issued = new Map();
  let pricing = null;
  const registry = opts.registry || createRegistry({ file: opts.registryFile, allowHttp: opts.allowHttp });
  let page = null;
  const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  function discovery(query) {
    const listed = registry.list('resource', query);
    return {
      x402Version: 1,
      items: listed.items.map(e => ({
        resource: e.url,
        type: 'http',
        x402Version: 1,
        accepts: e.schemes.map(scheme => ({
          scheme, network: e.network, maxAmountRequired: e.price, asset: e.asset, payTo: e.payTo,
          resource: e.url, description: e.description, mimeType: 'application/json',
          extra: { method: e.method, facilitator: e.facilitator || null },
        })),
        lastUpdated: e.createdAt,
        metadata: { id: e.id, name: e.name, tags: e.tags },
      })),
      pagination: { limit: listed.limit, offset: listed.offset, total: listed.total },
    };
  }

  async function publicRoute(req, res, url) {
    const json = { 'content-type': 'application/json' };
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const query = Object.fromEntries(url.searchParams);
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      if (!page) page = fs.readFileSync(PAGE_PATH, 'utf8');
      send(res, 200, page, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60' });
      return true;
    }
    if (req.method === 'GET' && (p === '/discovery/resources' || p === '/list')) { send(res, 200, discovery(query), json); return true; }
    if (req.method === 'GET' && p === '/discovery/facilitators') { send(res, 200, registry.list('facilitator', query), json); return true; }
    if (req.method === 'GET' && p === '/registry') {
      send(res, 200, { resources: registry.list('resource', { limit: 100 }).total, facilitators: registry.list('facilitator', { limit: 100 }).total,
        routes: ['GET/POST /registry/resources', 'GET/POST /registry/facilitators', 'GET /registry/{id}', 'GET /discovery/resources', 'GET /discovery/facilitators'],
        note: 'Public listing only. Registering does not sign, verify, or move funds.' }, json);
      return true;
    }
    const m = p.match(/^\/registry\/(resources|facilitators)$/);
    if (m) {
      const kind = m[1] === 'resources' ? 'resource' : 'facilitator';
      if (req.method === 'GET') { send(res, 200, registry.list(kind, query), json); return true; }
      if (req.method === 'POST') { const out = registry.add(kind, await readBody(req), ipOf(req)); send(res, out.status, out.body, json); return true; }
    }
    const one = p.match(/^\/registry\/([0-9a-f]{16})$/);
    if (req.method === 'GET' && one) { const e = registry.get(one[1]); send(res, e ? 200 : 404, e || { error: 'not found' }, json); return true; }
    return false;
  }

  function ensurePricing() {
    if (!pricing) {
      pricing = connection.getMinimumBalanceForRentExemption(0).then(rent => {
        const floor = value => {
          const n = BigInt(value);
          const min = BigInt(rent);
          return (n > min ? n : min).toString();
        };
        exactAmount = floor(exactAmount);
        splits = splits.map(floor);
      });
    }
    return pricing;
  }

  function issue(scheme) {
    const challenge = scheme === 'mpp'
      ? pay.buildChallenge({
        scheme: 'mpp',
        feePayer: facilitator.publicKey,
        recipients: [
          { address: payeeA, amount: splits[0] },
          { address: payeeB, amount: splits[1] },
        ],
        resource: '/resource',
      })
      : pay.buildChallenge({
        scheme: scheme === 'x402' ? 'x402' : 'exact',
        amount: exactAmount,
        payTo,
        feePayer: facilitator.publicKey,
        resource: '/resource',
      });
    issued.set(challenge.nonce, challenge);
    return challenge;
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 65536) {
          reject(Object.assign(new Error('body too large'), { status: 413 }));
          req.destroy();
        }
      });
      req.on('end', () => {
        if (!body) return resolve({});
        try { resolve(JSON.parse(body)); } catch { reject(Object.assign(new Error('invalid json'), { status: 400 })); }
      });
      req.on('error', reject);
    });
  }

  function send(res, status, body, headers) {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
      'access-control-allow-origin': '*',
      'access-control-expose-headers': 'www-authenticate, x-payment-response, payment-response',
      ...headers,
    });
    res.end(payload);
  }

  function paymentFromBody(body) {
    const payment = body.paymentPayload || body.payment || null;
    const challenge = body.paymentRequirements || body.challenge || (body.accepts ? body : null);
    return { payment, challenge };
  }

  async function confirm(signature) {
    const latest = await connection.getLatestBlockhash('confirmed');
    await connection.confirmTransaction({
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    }, 'confirmed');
  }

  function prepare(payment) {
    const tx = Transaction.from(Buffer.from(payment.payload.transaction, 'base64'));
    if (!tx.feePayer || tx.feePayer.toBase58() !== facilitator.publicKey.toBase58()) {
      throw Object.assign(new Error('fee payer must be the facilitator'), { status: 400 });
    }
    const mine = tx.signatures.find(sig => sig.publicKey.equals(facilitator.publicKey));
    if (!mine || mine.signature === null) tx.partialSign(facilitator);
    if (!tx.signature) throw Object.assign(new Error('facilitator signature missing'), { status: 400 });
    return { raw: tx.serialize(), signature: bs58.encode(Buffer.from(tx.signature)) };
  }

  async function signatureStatus(signature) {
    if (!signature) return null;
    const result = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
    return result && result.value ? result.value[0] : null;
  }

  function acceptsSettlement(verdict) {
    const parts = verdict.split || [];
    if (verdict.feePayer !== facilitator.publicKey.toBase58()) return false;
    if (verdict.scheme === 'mpp') {
      const want = [
        { address: payeeA.toBase58(), amount: splits[0] },
        { address: payeeB.toBase58(), amount: splits[1] },
      ];
      return parts.length === want.length && want.every(row => parts.some(part => part.address === row.address && part.amount === row.amount));
    }
    return parts.length === 1 && parts[0].address === payTo.toBase58() && parts[0].amount === exactAmount;
  }

  async function settle(payment, challenge) {
    const verdict = pay.settleIntent({ challenge, payment, seen });
    if (!verdict.submit) return { ok: false, verdict };
    if (!acceptsSettlement(verdict)) {
      return { ok: false, verdict: { ...verdict, ok: false, submit: false, reason: 'payment does not match the challenge' } };
    }
    // Claim before the first await so overlapping settle calls cannot both submit.
    seen.add(verdict.nonce, verdict.payerSignature);
    let signature = null;
    let accepted = false;
    try {
      const prepared = prepare(payment);
      signature = prepared.signature;
      signature = await connection.sendRawTransaction(prepared.raw, { skipPreflight: false });
      accepted = true;
      await confirm(signature);
    } catch (error) {
      const duplicate = /already been processed|AlreadyProcessed/i.test(String(error && error.message));
      let row = null;
      if (!duplicate) {
        try { row = await signatureStatus(signature); } catch { row = null; }
      }
      const landedOk = duplicate || Boolean(row && !row.err);
      if (!landedOk) {
        if (!row) seen.release(verdict.nonce, verdict.payerSignature);
        throw error;
      }
      if (!accepted && !signature) throw error;
    }
    issued.delete(verdict.nonce);
    return { ok: true, signature, verdict };
  }

  function rejected(challenge, reason) {
    const http = challenge ? pay.unpaidHttp(challenge) : {
      status: 402,
      headers: { 'content-type': 'application/json' },
      body: { x402Version: 1, error: reason, network: pay.NETWORK },
    };
    return { status: 402, headers: { ...http.headers, 'content-type': 'application/json' }, body: { ...http.body, error: reason || http.body.error } };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'content-type, x-payment, payment-signature',
          'access-control-allow-methods': 'GET,POST,OPTIONS',
        });
        return res.end();
      }
      if (await publicRoute(req, res, url)) return;
      await ensurePricing();
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { ok: true }, { 'content-type': 'application/json' });
      }
      if (req.method === 'GET' && url.pathname === '/supported') {
        return send(res, 200, {
          kinds: pay.supportedKinds().kinds,
          network: pay.NETWORK,
          feePayer: facilitator.publicKey.toBase58(),
          payTo: payTo.toBase58(),
          amount: exactAmount,
          mpp: {
            recipients: [
              { address: payeeA.toBase58(), amount: splits[0] },
              { address: payeeB.toBase58(), amount: splits[1] },
            ],
          },
        }, { 'content-type': 'application/json' });
      }
      if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/resource') {
        const header = pay.readPaymentHeader(req.headers);
        const scheme = url.searchParams.get('scheme') === 'mpp' ? 'mpp' : 'exact';
        if (!header.ok) {
          const http = pay.unpaidHttp(issue(scheme));
          return send(res, http.status, http.body, http.headers);
        }
        const payment = header.payment;
        const challenge = issued.get(String(payment.nonce || ''));
        if (!challenge) {
          const reason = seen.has(payment.nonce, null) ? 'replayed proof' : 'unknown challenge';
          const http = rejected(null, reason);
          return send(res, http.status, http.body, http.headers);
        }
        const settled = await settle(payment, challenge);
        if (!settled.ok) {
          const http = rejected(challenge, settled.verdict.reason);
          return send(res, http.status, http.body, http.headers);
        }
        const response = { ...pay.paymentResponseBody(settled.verdict), success: true, transaction: settled.signature };
        const encoded = pay.encodePaymentHeader(response);
        return send(res, 200, pay.PROTECTED_RESOURCE, {
          'content-type': 'text/plain; charset=utf-8',
          'x-payment-response': encoded,
          'payment-response': encoded,
        });
      }
      if (req.method === 'POST' && (url.pathname === '/verify' || url.pathname === '/settle')) {
        const body = await readBody(req);
        const { payment, challenge } = paymentFromBody(body);
        if (!payment || !challenge) return send(res, 400, { error: 'payment and challenge are required' }, { 'content-type': 'application/json' });
        if (url.pathname === '/verify') {
          const verdict = pay.verifyPayment({ challenge, payment, seen });
          return send(res, 200, {
            isValid: verdict.ok,
            invalidReason: verdict.reason,
            movesFunds: false,
            feePayer: verdict.feePayer || null,
            payer: verdict.payer || null,
            split: verdict.split || null,
            network: pay.NETWORK,
          }, { 'content-type': 'application/json' });
        }
        const settled = await settle(payment, challenge);
        if (!settled.ok) {
          return send(res, 402, {
            success: false,
            error: settled.verdict.reason,
            network: pay.NETWORK,
          }, { 'content-type': 'application/json' });
        }
        return send(res, 200, {
          success: true,
          transaction: settled.signature,
          network: pay.NETWORK,
          feePayer: settled.verdict.feePayer,
          payer: settled.verdict.payer,
          split: settled.verdict.split,
        }, { 'content-type': 'application/json' });
      }
      send(res, 404, { error: 'not found' }, { 'content-type': 'application/json' });
    } catch (error) {
      if (res.writableEnded) return;
      const status = error.status || 502;
      send(res, status, { error: error.message || 'facilitator error', network: pay.NETWORK }, { 'content-type': 'application/json' });
    }
  });

  return { server, connection, seen, facilitator, payTo, payeeA, payeeB, rpc, registry };
}

async function listen(app, port = 0, host = '127.0.0.1') {
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(port, host, resolve);
  });
  const address = app.server.address();
  return `http://${host}:${address.port}`;
}

if (require.main === module) {
  const app = createPaymentsServer();
  const port = +process.env.PORT || 8090;
  listen(app, port, '0.0.0.0').then(url => {
    console.log(`clawd facilitator ${url} feePayer ${app.facilitator.publicKey.toBase58()} rpc ${app.rpc}`);
  }).catch(error => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { createPaymentsServer, listen };
