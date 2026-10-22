// Clawd-local asset reads: owner holdings with names, and parsed token transfers.
function createLedger() {
  return { mints: {}, balances: [] };
}

function registerMint(ledger, { mint, name, decimals = 0, symbol = '' } = {}) {
  if (!mint || typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('mint name required');
  }
  ledger.mints[mint] = {
    mint: String(mint),
    name: name.trim(),
    decimals: Number(decimals) || 0,
    symbol: symbol ? String(symbol) : '',
  };
  return ledger.mints[mint];
}

function setBalance(ledger, { owner, mint, amount } = {}) {
  if (!owner || !mint) throw new Error('owner and mint required');
  if (!ledger.mints[mint]) throw new Error('unknown mint');
  const balance = typeof amount === 'bigint' ? amount.toString() : String(amount);
  if (!/^\d+$/.test(balance)) throw new Error('amount');
  const existing = ledger.balances.find(row => row.owner === owner && row.mint === mint);
  if (existing) existing.amount = balance;
  else ledger.balances.push({ owner: String(owner), mint: String(mint), amount: balance });
  return { owner: String(owner), mint: String(mint), amount: balance };
}

function getAssetsByOwner(ledger, owner) {
  const items = ledger.balances.filter(row => row.owner === owner).map(row => {
    const meta = ledger.mints[row.mint];
    return {
      interface: 'FungibleToken',
      id: row.mint,
      content: { metadata: { name: meta.name, symbol: meta.symbol } },
      token_info: {
        balance: row.amount,
        decimals: meta.decimals,
        mint: row.mint,
      },
      ownership: { owner: row.owner },
    };
  });
  return { total: items.length, limit: 1000, page: 1, items };
}

function infoOf(instruction) {
  if (!instruction || typeof instruction !== 'object') return null;
  const parsed = instruction.parsed && typeof instruction.parsed === 'object'
    ? instruction.parsed
    : instruction;
  const type = parsed.type || instruction.type;
  if (type !== 'transfer' && type !== 'transferChecked') return null;
  const info = parsed.info && typeof parsed.info === 'object' ? parsed.info : parsed;
  if (!info.source || !info.destination) return null;
  const amount = info.amount != null
    ? info.amount
    : (info.tokenAmount && info.tokenAmount.amount != null ? info.tokenAmount.amount : null);
  if (amount == null) return null;
  return {
    type: String(type),
    source: String(info.source),
    destination: String(info.destination),
    amount: String(amount),
  };
}

function parseTransfer(tx) {
  const wrapped = tx && tx.transaction && tx.transaction.message;
  const direct = tx && tx.message;
  const lists = [];
  if (wrapped && Array.isArray(wrapped.instructions)) lists.push(wrapped.instructions);
  if (direct && Array.isArray(direct.instructions)) lists.push(direct.instructions);
  if (tx && Array.isArray(tx.instructions)) lists.push(tx.instructions);
  if (tx && tx.meta && Array.isArray(tx.meta.innerInstructions)) {
    for (const inner of tx.meta.innerInstructions) {
      if (inner && Array.isArray(inner.instructions)) lists.push(inner.instructions);
    }
  }
  for (const list of lists) {
    for (const instruction of list) {
      const parsed = infoOf(instruction);
      if (parsed) return parsed;
    }
  }
  return { ok: false, reason: 'no transfer' };
}

module.exports = {
  createLedger,
  registerMint,
  setBalance,
  getAssetsByOwner,
  parseTransfer,
};
