// Records real Sui mainnet dry runs of the recorded Cetus routes, at the
// trade's size and at OA-29's reference size, that the price impact tests
// (social feed OA-29) replay. Each route is the aggregator's recorded answer
// (packages/server/test/fixtures/modules/social/trades/fixtures/cetus-routes.json, replayed through the
// SDK as the tests do), built into the swap the quote service would dry-run
// (`swapKind`, with the reference route from `referenceRoute`) and simulated
// on the mainnet fullnode exactly as the service does (`fullnodeTradeChain`:
// no gas payment, the fullnode's mocked gas). It keeps what the dry-run
// verdict reads, as the fullnode answered it: the effects' status and gas, and
// the balance changes.
//
//   node --no-warnings --experimental-strip-types test/scripts/social-trade-dry-runs.ts
//
// It reaches the mainnet fullnode (SUI_MAINNET_GRPC_URL) and nothing else: no
// aggregator request (the routes are replayed), no wallet, no key, nothing
// signed or executed. The senders are public mainnet addresses that held the
// input when recorded; a dry run only reads their coins. Tests never run it;
// they replay the file it writes, packages/server/test/fixtures/modules/social/trades/fixtures/dry-runs.json.
// The pairs only mean something while SALE_B's pool still holds the state
// cetus-routes.json was recorded at: the script refuses to write if a trade's
// dry run gives other than the recorded route's amount out.
import fs from "node:fs";

import { SuiGrpcClient } from "@mysten/sui/grpc";

import { SUI_MAINNET_GRPC_URL } from "../../../../packages/core/src/lib/sui-mainnet.ts";
import type { TradeRoute } from "@blast/server/modules/social/trades/aggregator.ts";
import { dryRunVerdict, fullnodeTradeChain, simulationBytes, swapKind, type TradeSimulationResult } from "@blast/server/modules/social/trades/chain.ts";
import { replayRouter } from "../../../../packages/server/test/fixtures/modules/social/trades/fixtures.ts";
import { referenceAmountIn, referenceRoute } from "@blast/server/modules/social/trades/reference.ts";

const OUT = new URL("../../../../packages/server/test/fixtures/modules/social/trades/fixtures/dry-runs.json", import.meta.url);
const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const SALE_B = "0x5650d58030f361f60f81913b54bf026e93e957bfbf506234f8f2e83bd3bfbd85::sale_tokens::SALE_B";
/** Sent SALE_B's pool transactions in the owner's mainnet presale run (2026-10-04); held 0.43 SUI when recorded. */
const RUN_WALLET = "0xff6821c23e073a778f7db530c1f71cc30437ad784c0b431b624ed664e9468861";
/** Was sent SALE_B in that run; held 317,434,869,739,471 SALE_B atoms when recorded. */
const SALE_B_HOLDER = "0x0c75db1d69fde2b4cb1d1f70139b6eb9033f8f28fa10de11a7f62f7144d0a75c";

/**
 * `route` names a recording in cetus-routes.json; `amount`, when set, takes
 * that route at a smaller size (`referenceRoute`, the same scaling the
 * reference run uses), for a sender that holds less than the recording sold.
 */
type Case = Readonly<{ name: string; route: string; from: string; target: string; amount: bigint; scaledTo?: bigint; sender: string }>;

const CASES: readonly Case[] = [
  { name: "sui-sale-b", route: "sui-sale-b", from: SUI, target: SALE_B, amount: 100_000_000n, sender: RUN_WALLET },
  { name: "sui-sale-b-double", route: "sui-sale-b-double", from: SUI, target: SALE_B, amount: 200_000_000n, sender: RUN_WALLET },
  // A sell into SUI: the dry run's SUI change is what the swap gave less the gas. Too small for a reference run.
  { name: "sale-b-sui-small", route: "sale-b-sui", from: SALE_B, target: SUI, amount: 100_000_000_000_000_000n, scaledTo: 300_000_000_000_000n, sender: SALE_B_HOLDER },
];

type Kept = Readonly<{
  $kind: string;
  effects: unknown;
  balanceChanges: unknown;
}>;

function kept(result: TradeSimulationResult): Kept {
  const transaction = result.$kind === "Transaction" ? result.Transaction : result.FailedTransaction;
  const effects = transaction?.effects;
  return {
    $kind: result.$kind,
    effects: { status: effects?.status ?? null, gasUsed: effects?.gasUsed ?? null },
    balanceChanges: transaction?.balanceChanges ?? [],
  };
}

const client = new SuiGrpcClient({ network: "mainnet", baseUrl: SUI_MAINNET_GRPC_URL });
const chain = fullnodeTradeChain(client);
const { router } = replayRouter();
const price = await chain.referenceGasPrice();
const dryRuns: unknown[] = [];

async function record(name: string, kind: "trade" | "reference", entry: Case, route: TradeRoute) {
  const bytes = simulationBytes({
    kind: await swapKind({ router, route, sender: entry.sender, inCoin: entry.from, slippageBps: 50, useGasCoin: false }, client),
    sender: entry.sender,
    gasOwner: entry.sender,
    price,
  });
  const result = await chain.simulate(bytes);
  const verdict = dryRunVerdict(result, { aggregatorPackage: route.aggregatorPackage, sender: entry.sender, outCoin: entry.target });
  if (verdict.status !== "passed" || verdict.received === null) throw new Error(`${name}: the dry run did not pass`);
  if (kind === "trade" && entry.scaledTo === undefined && verdict.received !== route.amountOut) {
    throw new Error(`${name}: the pool moved since cetus-routes.json (${verdict.received} ≠ ${route.amountOut}); re-record both`);
  }
  dryRuns.push({
    name,
    route: entry.route,
    run: kind,
    sender: entry.sender,
    amount_in: route.amountIn.toString(),
    pools: route.paths.map((path) => path.poolId),
    result: kept(result),
  });
  console.log(`${name}: ${route.amountIn} in, ${verdict.received} out`);
}

for (const entry of CASES) {
  const answer = await router.findRoute({ from: entry.from, target: entry.target, amount: entry.amount, byAmountIn: true });
  if (answer.status !== "route") throw new Error(`${entry.name}: no recorded route`);
  const trade = entry.scaledTo === undefined ? answer.route : referenceRoute(answer.route, entry.scaledTo, router.fee);
  if (!trade) throw new Error(`${entry.name}: the route does not scale to ${entry.scaledTo}`);
  await record(entry.name, "trade", entry, trade);
  const size = referenceAmountIn(trade.amountIn, trade.amountOut);
  const reference = size === null ? null : referenceRoute(trade, size, router.fee);
  if (reference) await record(`${entry.name}-reference`, "reference", entry, reference);
}

fs.writeFileSync(
  OUT,
  `${JSON.stringify({
    source: "Sui mainnet fullnode (SUI_MAINNET_GRPC_URL, SimulateTransaction without gas selection: the fullnode's mocked gas), through @mysten/sui 2.31 and the quote service's own swap builder",
    recorded_at: new Date().toISOString(),
    gas_price: price.toString(),
    dry_runs: dryRuns,
  }, null, 2)}\n`,
);
console.log(`wrote ${dryRuns.length} dry runs to ${OUT.pathname}`);
