const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const chain = require('../chain');
const { runPage } = require('../scripts/browser-scripts');

const ROOT = path.join(__dirname, '..');

function snap(coin) {
  return {
    phase: coin.phase,
    name: coin.name,
    symbol: coin.symbol,
    virtualQuote: coin.curve.virtualQuote,
    virtualToken: coin.curve.virtualToken,
    realQuote: coin.curve.realQuote,
    realToken: coin.curve.realToken,
    heldBack: coin.curve.heldBack,
    ammQuote: coin.amm ? coin.amm.quote : null,
    ammToken: coin.amm ? coin.amm.token : null,
    holdings: { ...coin.holdings },
    balances: { ...coin.balances },
  };
}

test('a coin opens the published curve, trades move price, and graduation seeds the AMM', () => {
  const alpha = chain.createCoin({ name: 'Alpha', symbol: 'ALP' });
  const beta = chain.createCoin({ name: 'Beta', symbol: 'BET' });
  const whole = alpha.quoteScale;
  assert.equal(beta.quoteScale, whole);
  assert.notEqual(alpha, beta);
  assert.equal(alpha.name, 'Alpha');
  assert.equal(alpha.symbol, 'ALP');
  assert.equal(beta.name, 'Beta');
  assert.equal(beta.symbol, 'BET');
  assert.equal(alpha.supply, 1000000000n);
  assert.equal(beta.supply, 1000000000n);
  assert.equal(alpha.curve.realToken, 793100000n);
  assert.equal(beta.curve.realToken, 793100000n);
  assert.equal(alpha.curve.heldBack, 206900000n);
  assert.equal(beta.curve.heldBack, 206900000n);
  assert.equal(alpha.curve.virtualToken, 1073000000n);
  assert.equal(beta.curve.virtualToken, 1073000000n);
  assert.equal(alpha.curve.realQuote, 0n);
  assert.equal(beta.curve.realQuote, 0n);
  assert.equal(alpha.curve.virtualQuote, 30n * whole);
  assert.equal(beta.curve.virtualQuote, 30n * whole);
  assert.equal(alpha.amm, null);
  assert.equal(beta.amm, null);
  assert.equal(alpha.phase, 'curve');
  assert.equal(beta.phase, 'curve');
  const capRaw = alpha.curve.virtualQuote * alpha.supply / alpha.curve.virtualToken;
  const capText = chain.formatQuote(capRaw, whole);
  assert.ok(Number(capText) > 27.9 && Number(capText) < 28);
  console.log('spotMarketCap ' + capText);

  const quoted = chain.quoteBuy(alpha, whole);
  assert.equal(quoted.ok, true);
  assert.ok(quoted.tokensOut > 0n);
  assert.equal(alpha.curve.realQuote, 0n);
  assert.equal(alpha.curve.virtualQuote, 30n * whole);
  assert.equal(alpha.phase, 'curve');

  const betaBefore = snap(beta);
  const brokeBefore = snap(alpha);
  const broke = chain.buy(alpha, { wallet: 'carol', quoteIn: whole, creatorWallet: 'c', holderWallet: 'h' });
  assert.equal(broke.ok, false);
  assert.equal(broke.reason, 'balance');
  assert.deepEqual(snap(alpha), brokeBefore);

  chain.fund(alpha, 'alice', whole);
  chain.fund(alpha, 'bob', whole);
  const first = chain.buy(alpha, { wallet: 'alice', quoteIn: whole, creatorWallet: 'c', holderWallet: 'h' });
  const second = chain.buy(alpha, { wallet: 'bob', quoteIn: whole, creatorWallet: 'c', holderWallet: 'h' });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.fee, 0n);
  assert.equal(second.fee, 0n);
  assert.equal(first.net, whole);
  assert.equal(second.net, whole);
  assert.ok(second.tokensOut < first.tokensOut);
  assert.equal(alpha.curve.realQuote, first.net + second.net);
  assert.deepEqual(snap(beta), betaBefore);

  const feeCoin = chain.createCoin({ name: 'Fee', symbol: 'FEE', creatorBps: 100, holderBps: 50 });
  chain.fund(feeCoin, 'alice', whole);
  const feeBuy = chain.buy(feeCoin, { wallet: 'alice', quoteIn: whole, creatorWallet: 'c', holderWallet: 'h' });
  assert.equal(feeBuy.ok, true);
  assert.ok(feeBuy.fee > 0n);
  assert.equal(feeCoin.curve.realQuote, feeBuy.net);
  assert.ok(feeCoin.curve.realQuote < whole);
  assert.equal(feeCoin.curve.realQuote + feeBuy.fee, whole);

  const beforeOverSell = snap(alpha);
  const overSell = chain.sell(alpha, {
    wallet: 'alice',
    tokenIn: alpha.holdings.alice + 1n,
    creatorWallet: 'c',
    holderWallet: 'h',
  });
  assert.equal(overSell.ok, false);
  assert.equal(overSell.reason, 'balance');
  assert.deepEqual(snap(alpha), beforeOverSell);

  const priceBefore = snap(alpha);
  const clawdBefore = alpha.balances.alice;
  const sold = chain.sell(alpha, {
    wallet: 'alice',
    tokenIn: alpha.holdings.alice / 2n,
    creatorWallet: 'c',
    holderWallet: 'h',
  });
  assert.equal(sold.ok, true);
  assert.ok(sold.quoteOut > 0n);
  assert.ok(alpha.balances.alice > clawdBefore);
  assert.ok(alpha.curve.realQuote < priceBefore.realQuote);
  assert.ok(priceBefore.virtualQuote * alpha.curve.virtualToken > alpha.curve.virtualQuote * priceBefore.virtualToken);

  chain.fund(alpha, 'whale', 1000n * whole);
  const beforeOverBuy = snap(alpha);
  const overBuy = chain.buy(alpha, { wallet: 'whale', quoteIn: 1000n * whole, creatorWallet: 'c', holderWallet: 'h' });
  assert.equal(overBuy.ok, false);
  assert.equal(overBuy.reason, 'inventory');
  assert.deepEqual(snap(alpha), beforeOverBuy);

  const grad = chain.createCoin({ name: 'Grad', symbol: 'GRAD' });
  assert.equal(grad.quoteScale, whole);
  assert.equal(grad.curve.virtualQuote, 30n * whole);
  assert.equal(grad.curve.realQuote, 0n);
  const virtualBefore = grad.curve.virtualQuote;
  const cost = chain.completionQuote(grad);
  chain.fund(grad, 'alice', cost);
  chain.fund(grad, 'bob', whole);
  const balanceBefore = grad.balances.alice;
  const done = chain.buy(grad, { wallet: 'alice', quoteIn: cost, creatorWallet: 'c', holderWallet: 'h' });
  assert.equal(done.ok, true);
  assert.equal(done.completed, true);
  assert.equal(done.fee, 0n);
  assert.equal(done.tokensOut, 793100000n);
  assert.equal(grad.phase, 'amm');
  assert.equal(grad.curve.realToken, 0n);
  assert.equal(grad.amm.token, 206900000n);
  assert.equal(grad.amm.quote, grad.curve.realQuote);
  assert.notEqual(grad.amm.quote, grad.curve.virtualQuote);
  assert.notEqual(grad.amm.token, grad.curve.virtualToken);
  assert.equal(grad.curve.virtualQuote, virtualBefore + grad.curve.realQuote);
  assert.ok(grad.curve.realQuote > 85n * whole);
  assert.ok(grad.curve.realQuote < 86n * whole);
  assert.equal(grad.curve.realQuote * 279900000n, virtualBefore * 793100000n);
  assert.equal(balanceBefore - grad.balances.alice, grad.curve.realQuote);
  assert.equal(done.net, grad.curve.realQuote);
  assert.equal(chain.completionQuote(grad), 0n);
  const printedReserve = chain.formatQuote(grad.curve.realQuote, whole);
  console.log('realCurveClawd ' + printedReserve);
  console.log('ammClawd ' + chain.formatQuote(grad.amm.quote, whole));
  console.log('ammTokens ' + grad.amm.token.toString());
  assert.ok(Number(printedReserve) > 85 && Number(printedReserve) < 86);

  const frozen = snap(grad);
  const later = chain.buy(grad, { wallet: 'bob', quoteIn: whole, creatorWallet: 'c', holderWallet: 'h' });
  assert.equal(later.ok, true);
  assert.equal(grad.phase, 'amm');
  assert.equal(grad.curve.virtualQuote, frozen.virtualQuote);
  assert.equal(grad.curve.virtualToken, frozen.virtualToken);
  assert.equal(grad.curve.realQuote, frozen.realQuote);
  assert.equal(grad.curve.realToken, frozen.realToken);
  assert.ok(grad.amm.quote > frozen.ammQuote);
  assert.ok(grad.amm.token < frozen.ammToken);
  const midQuote = grad.amm.quote;
  const midToken = grad.amm.token;
  const laterSell = chain.sell(grad, {
    wallet: 'bob',
    tokenIn: grad.holdings.bob / 2n,
    creatorWallet: 'c',
    holderWallet: 'h',
  });
  assert.equal(laterSell.ok, true);
  assert.equal(grad.phase, 'amm');
  assert.equal(grad.curve.realQuote, frozen.realQuote);
  assert.equal(grad.curve.virtualQuote, frozen.virtualQuote);
  assert.equal(grad.curve.realToken, frozen.realToken);
  assert.ok(grad.amm.quote < midQuote);
  assert.ok(grad.amm.token > midToken);
  assert.equal(grad.phase, 'amm');
  assert.equal(grad.curve.realToken, 0n);
  assert.equal(chain.completionQuote(grad), 0n);
  assert.deepEqual(snap(beta), betaBefore);
});

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function startExplorer(port) {
  const child = spawn(process.execPath, ['explorer/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), VALIDATOR_RPC: 'http://127.0.0.1:9' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('explorer did not listen\n' + log)), 8000);
    child.stdout.on('data', (buf) => {
      log += buf.toString();
      if (log.includes('explorer on')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (buf) => { log += buf.toString(); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('explorer exited ' + code + '\n' + log));
    });
  });
  return {
    child,
    ready,
    output() { return log; },
  };
}

test('the explorer serves a launchpad page whose script buys on the published curve', async () => {
  const port = await freePort();
  const explorer = startExplorer(port);
  try {
    await explorer.ready;
    const base = 'http://127.0.0.1:' + port;
    const explored = await fetch(base + '/explorer');
    const explorerHtml = await explored.text();
    assert.equal(explored.status, 200);
    assert.match(explorerHtml, /href="\/launchpad"/);
    const href = explorerHtml.match(/href="(\/launchpad)"/);
    assert.ok(href);

    const first = await fetch(base + href[1]);
    const html = await first.text();
    assert.equal(first.status, 200);
    assert.match(html, /id="name"/);
    assert.match(html, /id="symbol"/);
    assert.match(html, /id="buy"/);
    assert.match(html, />Buy</);
    assert.match(html, /id="sell"/);
    assert.match(html, />Sell</);
    assert.match(html, /Name/);
    assert.match(html, /Symbol/);

    const second = await fetch(base + href[1]);
    const htmlAgain = await second.text();
    assert.equal(second.status, 200);
    assert.equal(htmlAgain, html);

    const script = await fetch(base + '/chain/market.js');
    assert.equal(script.status, 200);
    assert.equal(await script.text(), fs.readFileSync(path.join(ROOT, 'chain', 'market.js'), 'utf8'));
    const pageScript = await fetch(base + '/launchpad.js');
    assert.equal(pageScript.status, 200);
    const pageSource = await pageScript.text();
    assert.equal(pageSource.includes('require('), false);
    assert.equal(pageSource.includes('module.exports'), false);

    const loaded = runPage(path.join(ROOT, 'explorer', 'public', 'launchpad.html'));
    assert.equal(typeof loaded.window.window, 'object');
    assert.equal(Object.prototype.hasOwnProperty.call(loaded.window, 'module'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(loaded.window, 'require'), false);
    const entry = loaded.window.ClawdLaunchpad;
    const coin = entry.createCoin({ name: 'Sandbox', symbol: 'BOX' });
    const one = entry.QUOTE_SCALE;
    entry.fund(coin, 'ann', one);
    entry.fund(coin, 'ben', one);
    const buyFirst = entry.buy(coin, { wallet: 'ann', quoteIn: one, creatorWallet: 'c', holderWallet: 'h' });
    const buySecond = entry.buy(coin, { wallet: 'ben', quoteIn: one, creatorWallet: 'c', holderWallet: 'h' });
    assert.equal(buyFirst.ok, true);
    assert.equal(buySecond.ok, true);
    assert.ok(buySecond.tokensOut < buyFirst.tokensOut);

    console.log('SERVER ' + explorer.output().trim());
    console.log('HTML1 name symbol buy sell');
    console.log('HTML2 name symbol buy sell');
    console.log('PASS sandbox second buy fewer tokens ' + buySecond.tokensOut.toString() + ' < ' + buyFirst.tokensOut.toString());
  } finally {
    explorer.child.kill();
  }
});
