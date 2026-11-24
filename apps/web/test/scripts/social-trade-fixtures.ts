// Records the Cetus aggregator's real mainnet answers that the trade quote
// tests (social feed R3-30) replay. It runs the aggregator SDK's own
// `findRouters`, as production does, and keeps exactly what the SDK fetched:
// the request (coins, amount, providers) and the HTTP answer's status and
// body text, byte for byte (the body carries u64 amounts above 2^53, so it is
// stored as text and the SDK's own JSON parser reads it back in the tests).
//
//   node --no-warnings --experimental-strip-types test/scripts/social-trade-fixtures.ts
//
// It reaches the network (api-sui.cetus.zone) and nothing else: no wallet, no
// key, no fullnode, no API key. Tests never run it; they replay the file it
// writes, packages/server/test/fixtures/modules/social/trades/fixtures/cetus-routes.json, and refuse
// every other request. Re-record only on purpose, and review the diff: the
// quote tests assert the recorded pools and amounts.
import fs from "node:fs";

import { AggregatorClient, Env } from "@cetusprotocol/aggregator-sdk";

const OUT = new URL("../../../../packages/server/test/fixtures/modules/social/trades/fixtures/cetus-routes.json", import.meta.url);
const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
/**
 * Coins of the owner's mainnet presale run (contracts PR #54): SALE_B is
 * quoted in SUI and migrated to a Cetus pool; SALE_A is quoted in the run's
 * own TEST_SUI and migrated to Bluefin, so no route reaches it from SUI.
 */
const SALE_B = "0x5650d58030f361f60f81913b54bf026e93e957bfbf506234f8f2e83bd3bfbd85::sale_tokens::SALE_B";
const SALE_A = "0x5650d58030f361f60f81913b54bf026e93e957bfbf506234f8f2e83bd3bfbd85::sale_tokens::SALE_A";
const PROVIDERS = ["CETUS", "BLUEFIN"];

/**
 * `amount` is atoms, or `from:<recording>` for the exact input an earlier
 * exact-output recording answered (the quote service asks exactly that next).
 */
type Case = Readonly<{ name: string; from: string; target: string; amount: string; byAmountIn: boolean }>;

/**
 * The quotes the tests ask, each as the quote service asks it. (A tiny probe
 * for a marginal rate is deliberately not used: at 1/1000 of these amounts the
 * aggregator routes through meme-coin pools whose stale prices beat the deep
 * pools. The impact is the aggregator's own `deviation_ratio`, OA-27.)
 */
const CASES: readonly Case[] = [
  { name: "sui-usdc", from: SUI, target: USDC, amount: "1000000000", byAmountIn: true },
  { name: "sui-sale-b", from: SUI, target: SALE_B, amount: "100000000", byAmountIn: true },
  { name: "sui-sale-b-double", from: SUI, target: SALE_B, amount: "200000000", byAmountIn: true },
  { name: "usdc-sale-b", from: USDC, target: SALE_B, amount: "1000000", byAmountIn: true },
  { name: "sale-b-sui", from: SALE_B, target: SUI, amount: "100000000000000000", byAmountIn: true },
  { name: "sui-sale-b-exact-out", from: SUI, target: SALE_B, amount: "100000000000000000", byAmountIn: false },
  { name: "sui-sale-b-exact-out-in", from: SUI, target: SALE_B, amount: "from:sui-sale-b-exact-out", byAmountIn: true },
  { name: "sui-sale-a", from: SUI, target: SALE_A, amount: "100000000", byAmountIn: true },
];

type Recording = Readonly<{
  name: string;
  request: Readonly<{ from: string; target: string; amount: string; by_amount_in: boolean; providers: readonly string[] }>;
  url: string;
  status: number;
  body: string;
}>;

const realFetch = globalThis.fetch;
const aggregator = new AggregatorClient({ env: Env.Mainnet });
const recordings: Recording[] = [];
for (const listed of CASES) {
  const source = listed.amount.startsWith("from:") ? recordings.find((entry) => entry.name === listed.amount.slice(5)) : undefined;
  const entry = source ? { ...listed, amount: /"amount_in":(\d+)/.exec(source.body)![1]! } : listed;
  let captured: { url: string; status: number; body: string } | null = null;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://api-sui.cetus.zone/router_v3/find_routes?")) throw new Error(`refused ${url}`);
    const response = await realFetch(url, init);
    const body = await response.text();
    captured = { url: url.replace(/&v=\d+$/, ""), status: response.status, body };
    return new Response(body, { status: response.status, headers: response.headers });
  }) as typeof fetch;
  try {
    await aggregator.findRouters({ from: entry.from, target: entry.target, amount: entry.amount, byAmountIn: entry.byAmountIn, providers: PROVIDERS });
  } finally {
    globalThis.fetch = realFetch;
  }
  if (!captured) throw new Error(`${entry.name}: the SDK fetched nothing`);
  const { url, status, body } = captured as { url: string; status: number; body: string };
  recordings.push({
    name: entry.name,
    request: { from: entry.from, target: entry.target, amount: entry.amount, by_amount_in: entry.byAmountIn, providers: PROVIDERS },
    url,
    status,
    body,
  });
  console.log(`${entry.name}: ${status} ${body.length} bytes`);
}

fs.writeFileSync(
  OUT,
  `${JSON.stringify({
    source: "Cetus aggregator API (api-sui.cetus.zone/router_v3), Sui mainnet, through @cetusprotocol/aggregator-sdk 1.7.3 findRouters",
    recorded_at: new Date().toISOString(),
    recordings,
  }, null, 2)}\n`,
);
console.log(`wrote ${recordings.length} recordings to ${OUT.pathname}`);
