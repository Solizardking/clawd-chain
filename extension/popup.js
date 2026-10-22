function byId(id) {
  return document.getElementById(id);
}

const pinchButton = byId('pinch');
if (pinchButton) pinchButton.disabled = true;

async function pinch() {
  const button = byId('pinch');
  const status = byId('faucet');
  if (button) button.disabled = true;
  if (status) status.textContent = 'Mining proof of work…';
  try {
    const drop = await ClawdWallet.requestAirdrop();
    if (status) status.textContent = '+' + drop.amount + ' CLAWD';
    return drop;
  } catch (error) {
    if (status) status.textContent = error && error.message ? error.message : 'faucet error';
    throw error;
  } finally {
    if (button) button.disabled = false;
  }
}

async function signTransfer() {
  const recipient = byId('to').value;
  const amount = byId('amount').value;
  const signed = await ClawdWallet.buildTransfer({ recipient, amount });
  byId('signed').textContent = signed.sender + ' → ' + signed.recipient + ' · ' + signed.amount + ' CLAWD';
  return signed;
}

globalThis.__clawdBoot = (async function boot() {
  try {
    const key = await ClawdWallet.createOrRestore();
    byId('address').textContent = key.address;
    byId('network').textContent = 'Clawd Chain · ' + ClawdWallet.RPC;
    await ClawdWallet.refresh();
    byId('status').textContent = 'Local key ready';
    if (pinchButton) pinchButton.disabled = false;
  } catch (error) {
    byId('status').textContent = error && error.message ? error.message : 'Wallet offline';
  }
})();

byId('send').addEventListener('click', function () {
  return signTransfer().catch(function (error) {
    byId('signed').textContent = error && error.message ? error.message : 'Sign failed';
  });
});

byId('pinch').addEventListener('click', function () {
  return pinch().catch(function () {});
});
