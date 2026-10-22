// Thin form over the shipped curve. Classic script: no import map, no require.
(function () {
  var L = window.ClawdLaunchpad;
  var wallet = 'you';
  var coin = null;

  function $(id) { return document.getElementById(id); }

  function text(id, value) {
    var el = $(id);
    if (el) el.textContent = value;
  }

  function formatQuote(raw) {
    var micros = raw * 1000000n / L.QUOTE_SCALE;
    var whole = micros / 1000000n;
    var frac = (micros % 1000000n).toString();
    while (frac.length < 6) frac = '0' + frac;
    return whole.toString() + '.' + frac;
  }

  function formatCap(quoteRaw, tokenRaw, supply) {
    var micros = quoteRaw * supply * 1000000n / tokenRaw / L.QUOTE_SCALE;
    var whole = micros / 1000000n;
    var frac = (micros % 1000000n).toString();
    while (frac.length < 4) frac = '0' + frac;
    return whole.toString() + '.' + frac.slice(0, 4) + ' CLAWD';
  }

  function render() {
    if (!coin) {
      text('phase', 'no coin');
      text('price', '—');
      text('reserve', '—');
      text('supply', '—');
      text('sellable', '—');
      text('held', '—');
      text('balance', '—');
      return;
    }
    var quoteRaw = coin.phase === 'amm' ? coin.amm.quote : coin.curve.virtualQuote;
    var tokenRaw = coin.phase === 'amm' ? coin.amm.token : coin.curve.virtualToken;
    text('phase', coin.phase);
    text('status', coin.name + ' (' + coin.symbol + ')');
    text('price', formatCap(quoteRaw, tokenRaw, coin.supply));
    text('reserve', formatQuote(coin.curve.realQuote) + ' CLAWD');
    text('supply', coin.supply.toString());
    text('sellable', coin.curve.realToken.toString());
    text('held', (coin.holdings[wallet] || 0n).toString());
    text('balance', formatQuote(coin.balances[wallet] || 0n));
  }

  function parseQuote(value) {
    var match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(value).trim());
    if (!match) return null;
    var frac = match[2] || '';
    while (frac.length < 6) frac += '0';
    var micros = BigInt(match[1]) * 1000000n + BigInt(frac);
    if (micros <= 0n) return null;
    return micros * L.QUOTE_SCALE / 1000000n;
  }

  $('create').onclick = function () {
    try {
      coin = L.createCoin({ name: $('name').value, symbol: $('symbol').value });
      L.fund(coin, wallet, 1000n * L.QUOTE_SCALE);
      text('notice', 'curve open');
      render();
    } catch (err) {
      text('notice', (err && err.message) || 'create failed');
    }
  };

  $('buy').onclick = function () {
    if (!coin) return text('notice', 'create a coin first');
    var amount = parseQuote($('amount').value);
    if (amount == null) return text('notice', 'amount');
    var result = L.buy(coin, {
      wallet: wallet,
      quoteIn: amount,
      creatorWallet: 'creator',
      holderWallet: 'holders',
    });
    text('notice', result.ok ? 'bought ' + result.tokensOut.toString() : result.reason);
    render();
  };

  $('sell').onclick = function () {
    if (!coin) return text('notice', 'create a coin first');
    var raw = String($('tokens').value).trim();
    if (!/^\d+$/.test(raw) || raw === '0') return text('notice', 'tokens');
    var result = L.sell(coin, {
      wallet: wallet,
      tokenIn: BigInt(raw),
      creatorWallet: 'creator',
      holderWallet: 'holders',
    });
    text('notice', result.ok ? 'sold for ' + result.quoteOut.toString() : result.reason);
    render();
  };

  render();
})();
