// x402 payment gate in front of one premium clawd chain API route.
// GET /api/premium/chain-stats -> 402 until paid 0.001 wCLAWD, then live chain stats from RPC.
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createMiddleware } from "@faremeter/middleware/hono";
import { RPC_URL, NETWORK, WCLAWD_MINT, PRICE_BASE_UNITS, FACILITATOR_URL } from "./config.mjs";

const payTo = process.env.X402_PAY_TO;
if (!payTo) throw new Error("set X402_PAY_TO (treasury pubkey)");
const port = Number(process.env.PORT ?? 4022);
const base = process.env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}`;

const rpc = async (method, params = []) =>
  (await (await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()).result;

const app = new Hono();
app.get("/api/premium/health", (c) => c.json({ ok: true }));
app.use("/api/premium/chain-stats", await createMiddleware({
  facilitatorURL: FACILITATOR_URL,
  accepts: [{
    scheme: "exact", network: NETWORK, asset: WCLAWD_MINT, maxAmountRequired: PRICE_BASE_UNITS, payTo,
    resource: `${base}/api/premium/chain-stats`, description: "clawd chain premium stats (Alpenglow)", mimeType: "application/json", maxTimeoutSeconds: 120,
  }],
}));
app.get("/api/premium/chain-stats", async (c) => {
  const [slot, version, perf, supply] = await Promise.all([rpc("getSlot", [{ commitment: "finalized" }]), rpc("getVersion"), rpc("getRecentPerformanceSamples", [5]), rpc("getSupply")]);
  return c.json({ network: NETWORK, finalizedSlot: slot, version, recentPerformance: perf, supply: supply?.value?.total });
});
serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? "127.0.0.1" });
console.log(`clawd x402 gate on :${port}`);
