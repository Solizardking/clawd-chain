// End-to-end: wrap a little native CLAWD into wCLAWD, then call the gated route through Faremeter's
// fetch wrapper. Payer key from PAYER_KEYPAIR (path outside the repo). Prints the settlement tx.
import fs from "node:fs";
import { Connection, Keypair, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, createSyncNativeInstruction, NATIVE_MINT } from "@solana/spl-token";
import { wrap } from "@faremeter/fetch";
import { exact } from "@faremeter/payment-solana";
import { createLocalWallet } from "@faremeter/wallet-solana";
import { createSolanaNetwork } from "@faremeter/info/solana";
import { address } from "@solana/kit";
import { RPC_URL, NETWORK, WCLAWD_MINT } from "./config.mjs";

const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.PAYER_KEYPAIR, "utf8"))));
const url = process.env.GATE_URL ?? "http://127.0.0.1:4022/api/premium/chain-stats";
const conn = new Connection(RPC_URL, "confirmed");

const ata = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
if (ata.amount < 10_000_000n) {
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: ata.address, lamports: 10_000_000 }),
    createSyncNativeInstruction(ata.address)), [payer]);
  console.log("wrap tx", sig);
}
const unpaid = await fetch(url);
console.log("unpaid status", unpaid.status);

const wallet = await createLocalWallet(NETWORK, payer);
const paidFetch = wrap(fetch, { handlers: [exact.createPaymentHandler(wallet, address(WCLAWD_MINT), RPC_URL)] });
const res = await paidFetch(url);
const hdr = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
console.log("paid status", res.status);
if (hdr) console.log("settlement", Buffer.from(hdr, "base64").toString());
console.log(JSON.stringify(await res.json()).slice(0, 300));
