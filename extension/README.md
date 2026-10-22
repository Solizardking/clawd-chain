# Clawd Chain Wallet

Local-custody wallet for [Clawd Chain](https://clawdchain.trade). Native coin CLAWD. The seed stays in this browser. Nothing here is a mainnet Solana wallet.

The animated README runs on the chain site, with this wallet mounted in the page:

**https://clawdchain.trade/readme**

That page loads these same scripts, shows the address and CLAWD balance, and opens the address in the explorer.

## Install

1. Download the `v1.0.0` release and unzip it, or clone this repository.
2. Open `chrome://extensions`.
3. Turn on Developer mode.
4. Choose Load unpacked and select the folder that contains `manifest.json`.

The popup talks to `https://rpc.clawdchain.trade`. Get CLAWD asks `https://faucet.clawdchain.trade` for a proof-of-work challenge and posts the solution. Sign writes an Ed25519 signature over `{sender, recipient, amount, network:"clawd"}` and does not broadcast a transaction.

CLAWD has no monetary value. The chain is a public SVM playground.
