// clawd chain network + asset for x402. CLAWD is the chain's native token; x402 "exact" is an SPL
// transfer, so payments use the native mint (wrapped CLAWD, `So111…112`), 9 decimals.
export const RPC_URL = process.env.CLAWD_RPC_URL ?? "https://rpc.clawdchain.trade";
export const GENESIS_HASH = "BjbvUdJLreJzCfVEQZHi3D4QttNyp3P5mNXEvHw56kBP";
// CAIP-2 for Solana-family chains = "solana:" + first 32 chars of the genesis hash.
export const NETWORK = `solana:${GENESIS_HASH.slice(0, 32)}`;
export const WCLAWD_MINT = "So11111111111111111111111111111111111111112";
export const PRICE_BASE_UNITS = process.env.X402_PRICE ?? "1000000"; // 0.001 CLAWD per call
export const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "http://127.0.0.1:4021";
