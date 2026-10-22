(async function () {
  try { await window.__clawdBoot; } catch (error) {}
  const wallet = window.ClawdWallet;
  const addr = wallet && typeof wallet.getAddress === 'function' ? wallet.getAddress() : '';
  const el = document.getElementById('address');
  if (!el || !addr) return;
  const link = document.createElement('a');
  link.className = 'mono';
  link.href = '/address/' + addr;
  link.textContent = addr;
  el.replaceChildren(link);
})();
