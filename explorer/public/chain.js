// Classic browser script. Assigns window.ClawdChain. No import, no export.
(function (root) {
  var PROGRAMS = {
    CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d: 'Metaplex Core',
    CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J: 'Candy Machine',
    CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ: 'Candy Guard',
    '1DREGFgysWYxLnRnKQnwrxnJQeSMk2HmGaC6whw2B2p': 'Agent Identity',
    TLREGni9ZEyGC3vnPZtqUh95xQ8oPqJSvNjvB7FGK8S: 'Agent Tools',
    GNS1S5J5AspKXgpjz6SvKL66kPaKWAhaGRhCqPRxii2B: 'Genesis',
    metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: 'Token Metadata',
    TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'Token Program',
    TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: 'Token-2022',
    So11111111111111111111111111111111111111112: 'Wrapped SOL',
    Bf3jjD5Pojx5mHZVwJCWg7wC1oPg2hsn7ufsWaKoHv9E: 'Dark Protocol',
    JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: 'Jupiter',
    TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5v: 'Token Program',
    '11111111111111111111111111111111': 'System Program',
    Vote111111111111111111111111111111111111111: 'Vote Program',
    MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: 'Memo Program',
    '2AMyS5oLqvh2j4We5EUe9cHryd2vrCuVSdZtsZrP2PVH': 'Clawd Shield',
  };

  function programLabel(id) {
    if (id == null || id === '') return '';
    var key = String(id);
    return Object.prototype.hasOwnProperty.call(PROGRAMS, key) ? PROGRAMS[key] : key;
  }

  function rawAmount(row) {
    if (!row) return 0n;
    var ui = row.uiTokenAmount;
    var raw = ui && ui.amount != null ? ui.amount : row.amount;
    if (raw == null || raw === '') return 0n;
    try { return BigInt(raw); } catch (err) { return 0n; }
  }

  function asInt(value) {
    var max = 9007199254740991n;
    if (value > max || value < -max) return value.toString();
    return Number(value);
  }

  function tokenDeltas(pre, post) {
    var map = Object.create(null);
    function take(list, side) {
      if (!list || !list.length) return;
      for (var i = 0; i < list.length; i++) {
        var row = list[i];
        if (!row || row.accountIndex == null) continue;
        var key = String(row.accountIndex);
        if (!map[key]) map[key] = { accountIndex: row.accountIndex, pre: null, post: null };
        map[key][side] = row;
      }
    }
    take(pre, 'pre');
    take(post, 'post');
    var keys = Object.keys(map).sort(function (a, b) { return map[a].accountIndex - map[b].accountIndex; });
    var out = [];
    for (var i = 0; i < keys.length; i++) {
      var pair = map[keys[i]];
      var src = pair.post || pair.pre || {};
      var ui = src.uiTokenAmount || {};
      var decimals = ui.decimals != null ? ui.decimals : (src.decimals != null ? src.decimals : 0);
      out.push({
        accountIndex: pair.accountIndex,
        mint: src.mint == null ? '' : src.mint,
        owner: src.owner == null ? '' : src.owner,
        decimals: decimals,
        delta: asInt(rawAmount(pair.post) - rawAmount(pair.pre)),
      });
    }
    return out;
  }

  function classifyQuery(query) {
    var q = String(query == null ? '' : query).trim();
    if (/^\d+$/.test(q)) return { kind: 'slot', path: '/block/' + q };
    if (q.length >= 80) return { kind: 'signature', path: '/tx/' + q };
    return { kind: 'address', path: '/address/' + q };
  }

  root.ClawdChain = { programLabel: programLabel, tokenDeltas: tokenDeltas, classifyQuery: classifyQuery };
})(typeof window !== 'undefined' ? window : this);
