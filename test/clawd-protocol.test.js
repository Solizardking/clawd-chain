const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const market = require('../chain/market');
const mint = require('../chain/public-mint');
const names = require('../chain/names');
const assets = require('../chain/assets');
const compress = require('../chain/compress');
const permanence = require('../chain/permanence');
const attest = require('../chain/attest');
const relayer = require('../chain/relayer');
const { generateIdentity, publicKeyHex } = require('../chain/sign');
const assetApi = require('../api/asset-server');

test('curve trades move price, then an AMM takes the real reserve', () => {
  const curve = market.createCoin({ name: 'Move', symbol: 'MOVE' });
  const one = curve.quoteScale;
  market.fund(curve, 'alice', one);
  market.fund(curve, 'bob', one);
  const first = market.buy(curve, { wallet: 'alice', quoteIn: one, creatorWallet: 'c', holderWallet: 'h' });
  const second = market.buy(curve, { wallet: 'bob', quoteIn: one, creatorWallet: 'c', holderWallet: 'h' });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(curve.phase, 'curve');
  assert.ok(second.tokensOut < first.tokensOut);
  assert.equal(curve.curve.realQuote, one * 2n);
  assert.ok(curve.curve.virtualToken < 1073000000n);
  const beforeSell = {
    virtualQuote: curve.curve.virtualQuote,
    virtualToken: curve.curve.virtualToken,
    realQuote: curve.curve.realQuote,
    realToken: curve.curve.realToken,
  };
  const sold = market.sell(curve, {
    wallet: 'alice',
    tokenIn: curve.holdings.alice / 2n,
    creatorWallet: 'c',
    holderWallet: 'h',
  });
  assert.equal(sold.ok, true);
  assert.ok(sold.quoteOut > 0n);
  assert.ok(curve.curve.realQuote < beforeSell.realQuote);
  assert.ok(curve.curve.realToken > beforeSell.realToken);
  assert.ok(beforeSell.virtualQuote * curve.curve.virtualToken > curve.curve.virtualQuote * beforeSell.virtualToken);

  const graduating = market.createCoin({ name: 'Grad', symbol: 'GRAD' });
  const whole = graduating.quoteScale;
  assert.equal(graduating.name, 'Grad');
  assert.equal(graduating.symbol, 'GRAD');
  assert.equal(graduating.supply, 1000000000n);
  assert.equal(graduating.curve.realToken, 793100000n);
  assert.equal(graduating.curve.heldBack, 206900000n);
  assert.equal(graduating.curve.virtualToken, 1073000000n);
  assert.equal(graduating.curve.virtualQuote, 30n * whole);
  assert.equal(graduating.curve.realQuote, 0n);
  const cost = market.completionQuote(graduating);
  market.fund(graduating, 'alice', cost);
  market.fund(graduating, 'bob', whole);
  const cross = market.buy(graduating, { wallet: 'alice', quoteIn: cost, creatorWallet: 'c', holderWallet: 'h' });
  assert.equal(cross.ok, true);
  assert.equal(cross.completed, true);
  assert.equal(graduating.phase, 'amm');
  assert.equal(graduating.amm.token, 206900000n);
  assert.equal(graduating.amm.quote, graduating.curve.realQuote);
  assert.notEqual(graduating.amm.quote, graduating.curve.virtualQuote);
  assert.ok(graduating.curve.realQuote > 85n * whole);
  assert.ok(graduating.curve.realQuote < 86n * whole);
  const printedReserve = market.formatQuote(graduating.curve.realQuote, graduating.quoteScale);
  console.log('realCurveClawd ' + printedReserve);
  console.log('ammClawd ' + market.formatQuote(graduating.amm.quote, graduating.quoteScale));
  console.log('ammTokens ' + graduating.amm.token.toString());
  assert.equal(market.formatQuote(graduating.amm.quote, graduating.quoteScale), printedReserve);
  assert.ok(Number(printedReserve) > 85 && Number(printedReserve) < 86);
  const frozen = {
    virtualQuote: graduating.curve.virtualQuote,
    virtualToken: graduating.curve.virtualToken,
    realQuote: graduating.curve.realQuote,
    realToken: graduating.curve.realToken,
  };
  const fundedQuote = graduating.amm.quote;
  const fundedToken = graduating.amm.token;
  const laterBuy = market.buy(graduating, { wallet: 'bob', quoteIn: whole, creatorWallet: 'c', holderWallet: 'h' });
  assert.equal(laterBuy.ok, true);
  assert.equal(graduating.phase, 'amm');
  assert.equal(graduating.curve.virtualQuote, frozen.virtualQuote);
  assert.equal(graduating.curve.virtualToken, frozen.virtualToken);
  assert.equal(graduating.curve.realQuote, frozen.realQuote);
  assert.equal(graduating.curve.realToken, frozen.realToken);
  assert.ok(graduating.amm.quote > fundedQuote);
  assert.ok(graduating.amm.token < fundedToken);
  const midQuote = graduating.amm.quote;
  const midToken = graduating.amm.token;
  const laterSell = market.sell(graduating, {
    wallet: 'bob',
    tokenIn: graduating.holdings.bob / 2n,
    creatorWallet: 'c',
    holderWallet: 'h',
  });
  assert.equal(laterSell.ok, true);
  assert.ok(graduating.amm.quote < midQuote);
  assert.ok(graduating.amm.token > midToken);
  assert.equal(graduating.curve.realQuote, frozen.realQuote);
  assert.equal(graduating.curve.virtualQuote, frozen.virtualQuote);
  const quoteBefore = graduating.amm.quote;
  const tokenBefore = graduating.amm.token;
  const quoted = market.quoteBuy(graduating, whole);
  assert.equal(quoted.ok, true);
  assert.equal(quoted.phase, 'amm');
  assert.ok(quoted.tokensOut > 0n);
  assert.equal(graduating.amm.quote, quoteBefore);
  assert.equal(graduating.amm.token, tokenBefore);
  assert.equal(graduating.curve.realQuote, frozen.realQuote);
});

test('commit-reveal rejects a mismatch and a second reveal', () => {
  const book = market.createMarket({
    quoteReserve: 10000n,
    tokenReserve: 10000n,
    completeAt: 1000000n,
  });
  const secret = 'clawd-reveal-secret';
  const commitment = market.commitmentOf(secret);
  assert.equal(market.commit(book, { wallet: 'alice', commitment }).ok, true);
  const before = book.revealed.size;
  const mismatch = market.reveal(book, { commitment, secret: 'other-secret' });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, 'mismatch');
  assert.equal(book.revealed.size, before);
  assert.equal(market.reveal(book, { commitment, secret }).ok, true);
  const replay = market.reveal(book, { commitment, secret });
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, 'replay');
});

test('a wallet cap blocks one buyer and still lets another buy', () => {
  const book = market.createMarket({ walletCap: 1n });
  const whaleIn = book.quoteScale;
  let minnowIn = 1n;
  while (market.quoteBuy(book, minnowIn).tokensOut === 0n) minnowIn += 1n;
  market.fund(book, 'whale', whaleIn);
  market.fund(book, 'minnow', minnowIn);
  const before = {
    virtualQuote: book.curve.virtualQuote,
    realQuote: book.curve.realQuote,
    realToken: book.curve.realToken,
  };
  const denied = market.buy(book, { wallet: 'whale', quoteIn: whaleIn, creatorWallet: 'c', holderWallet: 'h' });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'wallet cap');
  assert.equal(book.curve.virtualQuote, before.virtualQuote);
  assert.equal(book.curve.realQuote, before.realQuote);
  assert.equal(book.curve.realToken, before.realToken);
  assert.equal(book.holdings.whale, undefined);
  const allowed = market.buy(book, { wallet: 'minnow', quoteIn: minnowIn, creatorWallet: 'c', holderWallet: 'h' });
  assert.equal(allowed.ok, true);
  assert.ok(book.curve.realQuote > before.realQuote);
  assert.ok((book.holdings.minnow || 0n) > 0n);
  assert.ok(book.holdings.minnow <= 1n);
});

test('creator and holder fee shares credit two wallets and sum to the fee', () => {
  const book = market.createMarket({ creatorBps: 100, holderBps: 50 });
  const quoteIn = book.quoteScale;
  market.fund(book, 'alice', quoteIn);
  const bought = market.buy(book, {
    wallet: 'alice',
    quoteIn,
    creatorWallet: 'creator-wallet',
    holderWallet: 'holder-wallet',
  });
  assert.equal(bought.ok, true);
  const creatorPaid = book.fees['creator-wallet'];
  const holderPaid = book.fees['holder-wallet'];
  assert.ok(creatorPaid > 0n);
  assert.ok(holderPaid > 0n);
  assert.equal(creatorPaid + holderPaid, bought.fee);
  assert.equal(book.curve.realQuote + creatorPaid + holderPaid, quoteIn);
  assert.equal(book.curve.realQuote, bought.net);
});

test('public mint allows a non-creator and rejects a closed or full sale', () => {
  const opened = mint.openCollection({ creator: 'CreatorKey', name: 'Public Clawd', supplyCap: 2 });
  assert.equal(opened.ok, true);
  const first = mint.mintPublic(opened.collection, { minter: 'HolderKey' });
  assert.equal(first.ok, true);
  assert.notEqual(first.asset.owner, opened.collection.creator);
  assert.equal(first.asset.owner, 'HolderKey');
  const saved = mint.readAsset(opened.collection, first.asset.id);
  assert.equal(saved.name, 'Public Clawd');
  assert.equal(saved.owner, 'HolderKey');
  assert.equal(mint.mintPublic(opened.collection, { minter: 'OtherKey' }).ok, true);
  const capped = mint.mintPublic(opened.collection, { minter: 'ThirdKey' });
  assert.equal(capped.ok, false);
  assert.equal(capped.reason, 'cap');

  const second = mint.openCollection({ creator: 'CreatorKey', name: 'Public Clawd', supplyCap: 5 });
  mint.closeCollection(second.collection);
  const closed = mint.mintPublic(second.collection, { minter: 'HolderKey' });
  assert.equal(closed.ok, false);
  assert.equal(closed.reason, 'closed');
  assert.equal(second.collection.minted, 0n);
});

test('holdings resolve to token names and balances', () => {
  const parsed = names.parseMintAccount({
    value: {
      data: {
        parsed: {
          info: { extensions: [{ extension: 'tokenMetadata', state: { name: 'Clawd Pup' } }] },
        },
      },
    },
  });
  assert.equal(parsed, 'Clawd Pup');
  const rows = names.resolveHoldings(
    [{ mint: 'MintPup', balance: '42' }, { mint: 'MintHat', amount: '7' }],
    { MintPup: parsed, MintHat: 'Clawd Hat' },
  );
  assert.equal(rows[0].name, 'Clawd Pup');
  assert.equal(rows[0].balance, '42');
  assert.notEqual(rows[0].name, rows[0].mint);
  assert.equal(rows[1].name, 'Clawd Hat');
  assert.equal(rows[1].balance, '7');
  assert.equal(names.parseMintAccount({ value: { data: { parsed: { info: {} } } } }), null);
});

test('asset reads return names and a parsed transfer', () => {
  const ledger = assets.createLedger();
  assets.registerMint(ledger, { mint: 'MintPup', name: 'Clawd Pup' });
  assets.registerMint(ledger, { mint: 'MintHat', name: 'Clawd Hat' });
  assets.setBalance(ledger, { owner: 'WalletA', mint: 'MintPup', amount: '42' });
  assets.setBalance(ledger, { owner: 'WalletA', mint: 'MintHat', amount: '7' });
  assets.setBalance(ledger, { owner: 'WalletB', mint: 'MintPup', amount: '1' });
  const owned = assets.getAssetsByOwner(ledger, 'WalletA');
  assert.equal(owned.items.length, 2);
  assert.equal(owned.items[0].content.metadata.name, 'Clawd Pup');
  assert.equal(owned.items[0].token_info.balance, '42');
  assert.equal(owned.items[1].content.metadata.name, 'Clawd Hat');
  assert.equal(owned.items[1].token_info.balance, '7');
  const parsed = assets.parseTransfer({
    transaction: {
      message: {
        instructions: [
          { parsed: { type: 'transfer', info: { source: 'SourceAta', destination: 'DestAta', amount: '42' } } },
        ],
      },
    },
  });
  assert.equal(parsed.type, 'transfer');
  assert.equal(parsed.source, 'SourceAta');
  assert.equal(parsed.destination, 'DestAta');
  assert.equal(parsed.amount, '42');
});

test('compressed account proofs follow the root and die after a transition', () => {
  const forest = compress.createForest();
  const made = compress.createAccount(forest, { owner: 'alice', data: 'v1' });
  assert.deepEqual(Object.keys(made.fingerprint), ['root']);
  assert.equal(compress.verifyInclusion(made.fingerprint.root, made.proof), true);
  const badLeaf = { ...made.proof, leaf: 'ab'.repeat(32), siblings: made.proof.siblings.map(item => ({ ...item })) };
  assert.equal(compress.verifyInclusion(made.fingerprint.root, badLeaf), false);
  const badSibling = {
    ...made.proof,
    siblings: made.proof.siblings.map((item, index) => index === 0 ? { ...item, hash: 'cd'.repeat(32) } : { ...item }),
  };
  assert.equal(compress.verifyInclusion(made.fingerprint.root, badSibling), false);
  const flippedRoot = made.fingerprint.root.slice(0, -1) + (made.fingerprint.root.endsWith('a') ? 'b' : 'a');
  assert.equal(compress.verifyInclusion(flippedRoot, made.proof), false);
  const moved = compress.transitionAccount(forest, made.account.address, 'v2');
  assert.notEqual(moved.proof.leaf, made.proof.leaf);
  assert.notEqual(moved.fingerprint.root, made.fingerprint.root);
  assert.equal(compress.verifyInclusion(made.fingerprint.root, made.proof), true);
  assert.equal(compress.verifyInclusion(moved.fingerprint.root, made.proof), false);
  assert.equal(compress.verifyInclusion(moved.fingerprint.root, moved.proof), true);
});

test('content ids, model records, and process replay', () => {
  const store = permanence.createStore();
  const bytes = Buffer.from([1, 2, 3, 4]);
  const changed = Buffer.from([1, 2, 3, 5]);
  const id = store.put(bytes);
  assert.equal(permanence.contentId(bytes), id);
  assert.equal(store.put(bytes), id);
  assert.ok(store.get(id).equals(bytes));
  assert.notEqual(permanence.contentId(changed), id);
  const record = permanence.storeModel(store, {
    repoId: 'huggingface/clawd-model',
    revision: 'rev-1',
    bytes,
  });
  assert.equal(record.repoId, 'huggingface/clawd-model');
  assert.equal(record.revision, 'rev-1');
  assert.equal(record.digest, id);
  assert.ok(store.get(record.digest).equals(bytes));

  const identity = generateIdentity();
  const process = permanence.openProcess(identity);
  assert.equal(permanence.openProcess(identity).id, process.id);
  permanence.appendMessage(process, identity, { op: 'set', key: 'model', value: 'rev-1' });
  permanence.appendMessage(process, identity, { op: 'set', key: 'weights', value: id });
  assert.deepEqual(process.state, permanence.replay(process.log));
  assert.equal(process.state.seq, process.log.length);
  assert.equal(process.state.store.model, 'rev-1');
  assert.equal(process.state.store.weights, id);
});

test('SVM attestation accepts a fresh matching quote and rejects the three bad cases', () => {
  const identity = generateIdentity();
  const signer = publicKeyHex(identity.publicKey);
  const measurement = 'measurement-clawd-tee';
  const quote = attest.signAttestation(identity, { measurement, nonce: 'nonce-1', svm: 'clawd', report: 'local' });
  const seen = new Set();
  const accepted = attest.verifyAttestation(quote, { measurement, signer, seen });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.reason, 'accepted');
  const wrong = attest.verifyAttestation(quote, { measurement: 'other-measurement', signer, seen: new Set() });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, 'wrong measurement');
  const corrupt = { ...quote, signature: (quote.signature[0] === 'a' ? 'b' : 'a') + quote.signature.slice(1) };
  const badSig = attest.verifyAttestation(corrupt, { measurement, signer, seen: new Set() });
  assert.equal(badSig.ok, false);
  assert.equal(badSig.reason, 'bad signature');
  const replay = attest.verifyAttestation(quote, { measurement, signer, seen });
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, 'replayed nonce');

  const gate = relayer.createRelayer({ measurement, signer });
  const second = attest.signAttestation(identity, { measurement, nonce: 'nonce-2', svm: 'clawd' });
  const relayed = gate.verdict(second);
  const direct = attest.verifyAttestation(second, { measurement, signer, seen: new Set() });
  assert.equal(relayed.ok, true);
  assert.equal(relayed.reason, direct.reason);
  const corruptRelay = gate.verdict(corrupt);
  const directCorrupt = attest.verifyAttestation(corrupt, { measurement, signer, seen: new Set() });
  assert.equal(corruptRelay.ok, false);
  assert.equal(corruptRelay.reason, directCorrupt.reason);
  const replayedRelay = gate.verdict(second);
  assert.equal(replayedRelay.ok, false);
  assert.equal(replayedRelay.reason, 'replayed nonce');
  const source = fs.readFileSync(path.join(__dirname, '..', 'chain', 'relayer.js'), 'utf8');
  assert.equal(/redpill|nvidia|helius\.dev|fetch\s*\(/i.test(source), false);
});

test('asset API HTTP bodies include the token name and the parsed transfer', async () => {
  const ledger = assetApi.createLedger();
  assetApi.registerMint(ledger, { mint: 'MintPup', name: 'Clawd Pup' });
  assetApi.setBalance(ledger, { owner: 'WalletA', mint: 'MintPup', amount: '42' });
  const api = await assetApi.startAssetApi(ledger);
  try {
    const assetsResponse = await fetch(api.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'getAssetsByOwner', params: { owner: 'WalletA' } }),
    });
    const assetsBody = await assetsResponse.json();
    assert.equal(assetsBody.result.items[0].content.metadata.name, 'Clawd Pup');
    assert.equal(assetsBody.result.items[0].token_info.balance, '42');
    const parseResponse = await fetch(api.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'parseTransfer',
        params: {
          transaction: {
            message: {
              instructions: [
                { parsed: { type: 'transfer', info: { source: 'SourceAta', destination: 'DestAta', amount: '42' } } },
              ],
            },
          },
        },
      }),
    });
    const parseBody = await parseResponse.json();
    assert.equal(parseBody.result.source, 'SourceAta');
    assert.equal(parseBody.result.destination, 'DestAta');
    assert.equal(parseBody.result.amount, '42');
  } finally {
    await api.close();
  }
});
