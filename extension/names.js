// Token name resolution for wallet holdings. Classic script and Node.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ClawdNames = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function parseMintAccount(info) {
    const value = info && info.value ? info.value : info;
    if (!value || typeof value !== 'object') return null;
    if (typeof value.name === 'string' && value.name.trim()) return value.name.trim();
    const parsed = value.data && value.data.parsed;
    if (!parsed || !parsed.info) return null;
    if (typeof parsed.info.name === 'string' && parsed.info.name.trim()) return parsed.info.name.trim();
    const extensions = Array.isArray(parsed.info.extensions) ? parsed.info.extensions : [];
    for (let i = 0; i < extensions.length; i++) {
      const state = extensions[i] && extensions[i].state;
      if (state && typeof state.name === 'string' && state.name.trim()) return state.name.trim();
    }
    return null;
  }

  function resolveHoldings(rows, namesByMint) {
    const list = Array.isArray(rows) ? rows : [];
    const names = namesByMint || {};
    return list.map(row => {
      const mint = row && row.mint ? String(row.mint) : '';
      const fromMap = typeof names[mint] === 'string' ? names[mint].trim() : '';
      const fromRow = row && typeof row.name === 'string' ? row.name.trim() : '';
      const name = fromMap || fromRow || null;
      const balance = row && row.balance != null ? String(row.balance) : (row && row.amount != null ? String(row.amount) : '0');
      return { mint, name, balance };
    });
  }

  return { parseMintAccount, resolveHoldings };
});
