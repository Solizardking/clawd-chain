(function () {
  const wallet = window.ClawdWallet;
  if (!wallet || typeof wallet.refresh !== 'function') return;
  const inner = wallet.refresh.bind(wallet);

  function linkAddress(addr) {
    const el = document.getElementById('address');
    if (!el || !addr) return;
    const link = document.createElement('a');
    link.className = 'mono';
    link.href = '/address/' + addr;
    link.textContent = addr;
    el.replaceChildren(link);
  }

  wallet.refresh = async function refreshFromExplorer() {
    const result = await inner();
    linkAddress(result && result.address ? result.address : wallet.getAddress());
    const network = document.getElementById('network');
    if (network) network.textContent = 'Clawd Chain · read through the explorer';
    return result;
  };
})();
