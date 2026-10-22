// Bonding-curve trades that migrate into a constant-product AMM.
// Quote amounts are an integer quantum of whole CLAWD. The quantum is
// 933 * 10^6 because the published completion price is 85 + 5/933 CLAWD,
// which is then an exact integer, and whole-token figures stay exact.
// Commit-reveal, per-wallet caps, and the creator/holder fee split live here too.
const QUOTE_SCALE = 933n * 1000000n;
const SUPPLY = 1000000000n;
const SELLABLE = 793100000n;
const HELD_BACK = 206900000n;
const VIRTUAL_TOKENS = 1073000000n;
const VIRTUAL_QUOTE_WHOLE = 30n;

function asBps(value) {
  const n = value == null ? 0 : value;
  if (!Number.isInteger(n) || n < 0 || n > 10000) {
    throw new Error('bps');
  }
  return BigInt(n);
}

function asPositive(value, label) {
  let n;
  try { n = BigInt(value); } catch { throw new Error(label); }
  if (n <= 0n) throw new Error(label);
  return n;
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(label);
  return value.trim();
}

function feeShares(amount, creatorBps, holderBps) {
  const creator = (amount * creatorBps) / 10000n;
  const holder = (amount * holderBps) / 10000n;
  return { fee: creator + holder, creator, holder };
}

// Six decimal places of whole CLAWD. Integer division only, so 85 + 5/933
// prints as 85.005359 and stays strictly inside (85, 86).
function formatQuote(raw, scale) {
  const quantum = scale == null ? QUOTE_SCALE : scale;
  let value = typeof raw === 'bigint' ? raw : BigInt(raw);
  const sign = value < 0n ? '-' : '';
  if (value < 0n) value = -value;
  const micros = (value * 1000000n) / quantum;
  const whole = micros / 1000000n;
  const frac = (micros % 1000000n).toString().padStart(6, '0');
  return sign + whole.toString() + '.' + frac;
}

function outGivenIn(reserveIn, reserveOut, amountIn) {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  return (reserveOut * amountIn) / (reserveIn + amountIn);
}

function sha256Hex(bytes) {
  return require('./codec').sha256Hex(bytes);
}

function createCoin({
  name,
  symbol,
  creatorBps = 0,
  holderBps = 0,
  walletCap = null,
} = {}) {
  const cap = walletCap == null ? null : asPositive(walletCap, 'wallet cap');
  return {
    name: requiredText(name, 'name'),
    symbol: requiredText(symbol, 'symbol'),
    supply: SUPPLY,
    quoteScale: QUOTE_SCALE,
    phase: 'curve',
    curve: {
      virtualQuote: VIRTUAL_QUOTE_WHOLE * QUOTE_SCALE,
      virtualToken: VIRTUAL_TOKENS,
      realQuote: 0n,
      realToken: SELLABLE,
      heldBack: HELD_BACK,
    },
    amm: null,
    creatorBps: asBps(creatorBps),
    holderBps: asBps(holderBps),
    walletCap: cap,
    holdings: {},
    balances: {},
    fees: {},
    pending: new Map(),
    revealed: new Set(),
  };
}

function createMarket(opts = {}) {
  return createCoin({
    name: opts.name || 'coin',
    symbol: opts.symbol || 'COIN',
    creatorBps: opts.creatorBps,
    holderBps: opts.holderBps,
    walletCap: opts.walletCap,
  });
}

function fund(market, wallet, amount) {
  if (!wallet) throw new Error('wallet');
  const credit = asPositive(amount, 'amount');
  market.balances[wallet] = (market.balances[wallet] || 0n) + credit;
  return market.balances[wallet];
}

function quotingPool(market) {
  if (market.phase === 'amm') return market.amm;
  return { quote: market.curve.virtualQuote, token: market.curve.virtualToken };
}

function completionQuote(market) {
  if (market.phase !== 'curve') return 0n;
  const realToken = market.curve.realToken;
  if (realToken <= 0n) return 0n;
  const denom = market.curve.virtualToken - realToken;
  if (denom <= 0n) throw new Error('inventory');
  const num = realToken * market.curve.virtualQuote;
  if (num % denom === 0n) return num / denom;
  return (num + denom - 1n) / denom;
}

function credit(market, wallet, amount) {
  if (!wallet || amount <= 0n) return;
  market.fees[wallet] = (market.fees[wallet] || 0n) + amount;
}

function buy(market, { wallet, quoteIn, creatorWallet, holderWallet } = {}) {
  if (!wallet) return { ok: false, reason: 'wallet' };
  let input;
  try { input = asPositive(quoteIn, 'amount'); } catch (error) {
    return { ok: false, reason: error.message };
  }
  const balance = market.balances[wallet] || 0n;
  if (input > balance) return { ok: false, reason: 'balance' };
  const shares = feeShares(input, market.creatorBps, market.holderBps);
  const net = input - shares.fee;
  if (net <= 0n) return { ok: false, reason: 'fee' };
  const pool = quotingPool(market);
  const tokensOut = outGivenIn(pool.quote, pool.token, net);
  if (tokensOut <= 0n) return { ok: false, reason: 'zero output' };
  if (market.phase === 'curve' && tokensOut > market.curve.realToken) {
    return { ok: false, reason: 'inventory' };
  }
  if (market.phase === 'amm' && tokensOut > market.amm.token) {
    return { ok: false, reason: 'inventory' };
  }
  const held = market.holdings[wallet] || 0n;
  if (market.walletCap != null && held + tokensOut > market.walletCap) {
    return { ok: false, reason: 'wallet cap' };
  }
  if (market.phase === 'curve') {
    market.curve.virtualQuote += net;
    market.curve.virtualToken -= tokensOut;
    market.curve.realQuote += net;
    market.curve.realToken -= tokensOut;
  } else {
    market.amm.quote += net;
    market.amm.token -= tokensOut;
  }
  market.balances[wallet] = balance - input;
  market.holdings[wallet] = held + tokensOut;
  credit(market, creatorWallet, shares.creator);
  credit(market, holderWallet, shares.holder);
  let completed = false;
  if (market.phase === 'curve' && market.curve.realToken === 0n) {
    market.amm = { quote: market.curve.realQuote, token: market.curve.heldBack };
    market.phase = 'amm';
    completed = true;
  }
  return {
    ok: true,
    tokensOut,
    net,
    fee: shares.fee,
    creatorShare: shares.creator,
    holderShare: shares.holder,
    completed,
    phase: market.phase,
  };
}

function sell(market, { wallet, tokenIn, creatorWallet, holderWallet } = {}) {
  if (!wallet) return { ok: false, reason: 'wallet' };
  let input;
  try { input = asPositive(tokenIn, 'amount'); } catch (error) {
    return { ok: false, reason: error.message };
  }
  const held = market.holdings[wallet] || 0n;
  if (input > held) return { ok: false, reason: 'balance' };
  const pool = quotingPool(market);
  const gross = outGivenIn(pool.token, pool.quote, input);
  if (gross <= 0n) return { ok: false, reason: 'zero output' };
  if (market.phase === 'curve' && gross > market.curve.realQuote) {
    return { ok: false, reason: 'inventory' };
  }
  if (market.phase === 'amm' && gross > market.amm.quote) {
    return { ok: false, reason: 'inventory' };
  }
  const shares = feeShares(gross, market.creatorBps, market.holderBps);
  const net = gross - shares.fee;
  if (net <= 0n) return { ok: false, reason: 'fee' };
  if (market.phase === 'curve') {
    market.curve.virtualToken += input;
    market.curve.virtualQuote -= gross;
    market.curve.realToken += input;
    market.curve.realQuote -= gross;
  } else {
    market.amm.token += input;
    market.amm.quote -= gross;
  }
  market.holdings[wallet] = held - input;
  market.balances[wallet] = (market.balances[wallet] || 0n) + net;
  credit(market, creatorWallet, shares.creator);
  credit(market, holderWallet, shares.holder);
  return { ok: true, quoteOut: net, fee: shares.fee, phase: market.phase };
}

function quoteBuy(market, quoteIn) {
  const input = BigInt(quoteIn);
  const shares = feeShares(input, market.creatorBps, market.holderBps);
  const net = input - shares.fee;
  const pool = quotingPool(market);
  const quoteBefore = pool.quote;
  const tokenBefore = pool.token;
  const tokensOut = outGivenIn(pool.quote, pool.token, net);
  return {
    ok: tokensOut > 0n,
    tokensOut,
    net,
    phase: market.phase,
    quote: quoteBefore,
    token: tokenBefore,
  };
}

function commitmentOf(secret) {
  return sha256Hex(Buffer.from(String(secret), 'utf8'));
}

function commit(market, { wallet, commitment } = {}) {
  if (!wallet || typeof commitment !== 'string' || commitment.length === 0) {
    return { ok: false, reason: 'commitment' };
  }
  if (market.revealed.has(commitment) || market.pending.has(commitment)) {
    return { ok: false, reason: 'commitment exists' };
  }
  market.pending.set(commitment, { wallet });
  return { ok: true };
}

function reveal(market, { commitment, secret } = {}) {
  if (typeof commitment !== 'string' || commitment.length === 0) {
    return { ok: false, reason: 'commitment' };
  }
  if (commitmentOf(secret) !== commitment) return { ok: false, reason: 'mismatch' };
  if (market.revealed.has(commitment)) return { ok: false, reason: 'replay' };
  const pending = market.pending.get(commitment);
  if (!pending) return { ok: false, reason: 'unknown' };
  market.pending.delete(commitment);
  market.revealed.add(commitment);
  return { ok: true, wallet: pending.wallet };
}

const api = {
  QUOTE_SCALE,
  SUPPLY,
  SELLABLE,
  HELD_BACK,
  VIRTUAL_TOKENS,
  VIRTUAL_QUOTE_WHOLE,
  createCoin,
  createMarket,
  fund,
  completionQuote,
  formatQuote,
  buy,
  sell,
  quoteBuy,
  commitmentOf,
  commit,
  reveal,
  feeShares,
};

if (typeof module === 'object' && module && module.exports) {
  module.exports = api;
}
const root = typeof window !== 'undefined' ? window : globalThis;
root.ClawdLaunchpad = api;
