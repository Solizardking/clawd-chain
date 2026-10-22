// Fresh consumer of the shipped market and compression entry points.
const chain = require('../chain');

const coin = chain.createCoin({ name: 'Canonical', symbol: 'CANON' });
const cost = chain.completionQuote(coin);
const whole = coin.quoteScale;
chain.fund(coin, 'alice', cost);
chain.fund(coin, 'bob', whole);
const bought = chain.buy(coin, {
  wallet: 'alice',
  quoteIn: cost,
  creatorWallet: 'creator-wallet',
  holderWallet: 'holder-wallet',
});
if (!bought.ok || bought.completed !== true || coin.phase !== 'amm') {
  console.error('market did not complete');
  process.exit(1);
}
if (coin.amm.token !== 206900000n) {
  console.error('amm was not seeded with the held-back tokens');
  process.exit(1);
}
const seededTokens = coin.amm.token;
const seededQuote = coin.amm.quote;
const realBefore = coin.curve.realQuote;
const later = chain.buy(coin, {
  wallet: 'bob',
  quoteIn: whole,
  creatorWallet: 'creator-wallet',
  holderWallet: 'holder-wallet',
});
if (!later.ok || coin.phase !== 'amm' || coin.curve.realQuote !== realBefore) {
  console.error('post-graduation buy moved the curve');
  process.exit(1);
}
if (coin.amm.quote === seededQuote) {
  console.error('post-graduation buy did not move the amm');
  process.exit(1);
}
const realCurveClawd = chain.formatQuote(realBefore, coin.quoteScale);
const realCurveAfter = chain.formatQuote(coin.curve.realQuote, coin.quoteScale);
const ammClawd = chain.formatQuote(seededQuote, coin.quoteScale);
const shown = Number(realCurveClawd);
if (!(shown > 85 && shown < 86) || realCurveAfter !== realCurveClawd || ammClawd !== realCurveClawd) {
  console.error('printed reserve is not the frozen completion CLAWD');
  process.exit(1);
}
console.log('phase ' + coin.phase);
console.log('realCurveClawd ' + realCurveClawd);
console.log('realCurveAfter ' + realCurveAfter);
console.log('ammClawd ' + ammClawd);
console.log('ammTokens ' + seededTokens.toString());

const forest = chain.createForest();
const made = chain.createAccount(forest, { owner: 'alice', data: 'permanence-v1' });
const accepted = chain.verifyInclusion(made.fingerprint.root, made.proof);
const rejected = chain.verifyInclusion(made.fingerprint.root, {
  index: made.proof.index,
  leaf: 'ab'.repeat(32),
  siblings: made.proof.siblings,
});
console.log('verdict ' + (accepted ? 'accept' : 'reject'));
console.log('verdict ' + (rejected ? 'accept' : 'reject'));
if (!accepted || rejected) process.exit(1);
