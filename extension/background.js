if (typeof importScripts === 'function') {
  importScripts('pow.js', 'names.js', 'wallet.js');
}

globalThis.ClawdBackground = {
  rpc: globalThis.ClawdWallet ? globalThis.ClawdWallet.RPC : '',
  unlock(seed) {
    return globalThis.ClawdWallet.createOrRestore(seed);
  },
};
