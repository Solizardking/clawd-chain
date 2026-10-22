const help = document.getElementById('file-help');
if (location.protocol === 'file:') help.hidden = false;

const Mint = globalThis.ClawdPublicMint;
let collection = null;

document.getElementById('mint-form').addEventListener('submit', function (event) {
  event.preventDefault();
  const result = document.getElementById('result');
  if (!Mint) {
    result.textContent = 'Mint rules did not load. Serve this folder over HTTP.';
    return;
  }
  const name = document.getElementById('name').value;
  const minter = document.getElementById('minter').value;
  const cap = document.getElementById('cap').value;
  if (!collection || collection.name !== name.trim() || collection.supplyCap !== BigInt(cap)) {
    const opened = Mint.openCollection({ creator: 'CreatorKey', name, supplyCap: cap });
    if (!opened.ok) {
      result.textContent = opened.reason;
      return;
    }
    collection = opened.collection;
  }
  const minted = Mint.mintPublic(collection, { minter });
  if (!minted.ok) {
    result.textContent = minted.reason;
    return;
  }
  const saved = Mint.readAsset(collection, minted.asset.id);
  result.textContent = saved.name + ' owned by ' + saved.owner;
});
