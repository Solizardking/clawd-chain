// Public NFT mint rules. Any wallet can mint until the sale is closed or the cap is met.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ClawdPublicMint = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function openCollection({ creator, name, supplyCap } = {}) {
    if (typeof creator !== 'string' || creator.trim().length === 0) {
      return { ok: false, reason: 'creator' };
    }
    if (typeof name !== 'string' || name.trim().length === 0) {
      return { ok: false, reason: 'name' };
    }
    let cap;
    try { cap = BigInt(supplyCap); } catch { return { ok: false, reason: 'cap' }; }
    if (cap <= 0n) return { ok: false, reason: 'cap' };
    return {
      ok: true,
      collection: {
        creator: creator.trim(),
        name: name.trim(),
        supplyCap: cap,
        minted: 0n,
        closed: false,
        assets: [],
      },
    };
  }

  function mintPublic(collection, { minter } = {}) {
    if (!collection || collection.closed) return { ok: false, reason: 'closed' };
    if (typeof minter !== 'string' || minter.trim().length === 0) {
      return { ok: false, reason: 'minter' };
    }
    if (collection.minted >= collection.supplyCap) return { ok: false, reason: 'cap' };
    collection.minted += 1n;
    const asset = {
      id: collection.name + ':' + collection.minted.toString(),
      name: collection.name,
      owner: minter.trim(),
    };
    collection.assets.push(asset);
    return { ok: true, asset };
  }

  function readAsset(collection, id) {
    if (!collection || !Array.isArray(collection.assets)) return null;
    return collection.assets.find(asset => asset.id === id) || null;
  }

  function closeCollection(collection) {
    if (!collection) return { ok: false, reason: 'collection' };
    collection.closed = true;
    return { ok: true };
  }

  return { openCollection, mintPublic, readAsset, closeCollection };
});
