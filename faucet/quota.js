// 24h faucet allowance math. Amounts are whole CLAWD, not lamports.
const DAY = 86_400_000;

function sumRecent(list, now, day = DAY) {
  return (list || []).filter(e => now - e.t < day).reduce((a, e) => a + e.a, 0);
}

function remainingClawd({ walletEvents, ipEvents, now, amount, ipCap, day = DAY }) {
  const walletUsed = sumRecent(walletEvents, now, day);
  const ipUsed = sumRecent(ipEvents, now, day);
  return {
    walletRemaining: Math.max(0, amount - walletUsed),
    ipRemaining: Math.max(0, ipCap - ipUsed),
  };
}

module.exports = { DAY, sumRecent, remainingClawd };
