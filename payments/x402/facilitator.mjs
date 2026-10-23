// Self-hosted x402 facilitator for clawd chain. Verifies + settles wCLAWD "exact" payments on
// rpc.clawdchain.trade. Fee-payer key comes from FACILITATOR_KEYPAIR (path, outside the repo).
import fs from "node:fs";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createFacilitatorRoutes } from "@faremeter/facilitator";
import { exact } from "@faremeter/payment-solana";
import { createSolanaNetwork } from "@faremeter/info/solana";
import { createKeyPairSignerFromBytes, address } from "@solana/kit";
import { RPC_URL, NETWORK, WCLAWD_MINT } from "./config.mjs";

const keyPath = process.env.FACILITATOR_KEYPAIR;
if (!keyPath) throw new Error("set FACILITATOR_KEYPAIR to a keypair file outside the repo");
const signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf8"))));
const network = createSolanaNetwork(NETWORK, "clawd-chain");
const handler = await exact.createFacilitatorHandler(network, RPC_URL, signer, address(WCLAWD_MINT), { maxRetries: 30, retryDelayMs: 500 });

const app = new Hono();
app.get("/health", (c) => c.json({ ok: true, network: NETWORK, feePayer: signer.address }));
app.route("/", createFacilitatorRoutes({ handlers: [handler], timeout: { getRequirements: 5000, getSupported: 5000 } }));
const port = Number(process.env.PORT ?? 4021);
serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? "127.0.0.1" });
console.log(`clawd x402 facilitator on :${port} network=${NETWORK} feePayer=${signer.address}`);
