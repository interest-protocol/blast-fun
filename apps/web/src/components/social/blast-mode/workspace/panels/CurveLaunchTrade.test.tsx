import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { BLAST_DEPLOYMENTS } from "@interest-protocol/blast-sdk/deployments";
import { installTestDom, waitFor } from "../../../../../../test/fixtures/social/test-dom.ts";

// The rail stands in for the coin page's curve flow: like it, a rail that is no longer live and holds no trade shows the
// fallback. The launch read answers from a table the tests can change.
const rail = `export const StandaloneCurveTrade = props => props.live ? "curve-rail:" + props.launchId + ":" + props.live : props.fallback;`;
const launches = `const pools = Object.assign(globalThis.curvePools ??= {}, { "0x1::curve::CURVE": "0xlaunch", "0x1::grad::GRAD": null });
export const readCurveLaunch = async asset => { const pool = pools[asset.coin_type]; if (pool instanceof Error) throw pool; return pool ?? null; };
export const bondingLaunchId = (client, coinType) => (globalThis.curveSeeds ??= {})[coinType];
export const mayTradeOnCurve = (asset, coin) => asset.network === "mainnet" && asset.presale_id === null && asset.coin_type !== "0x2::sui::SUI" && coin?.lifecycle !== "migrated";
export const curveLaunchQuery = (client, asset) => ({ queryKey: ["blast", "public", "workspace-curve-launch", asset.network, asset.coin_type], queryFn: () => readCurveLaunch(asset), placeholderData: () => bondingLaunchId(client, asset.coin_type) });`;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith("/panels/CurveLaunchTrade.tsx")) {
    if (specifier === "#web/components/launchpad/trade/CoinTrade.tsx") return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(rail)}` };
    if (specifier === "./curve-launch") return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(launches)}` };
  }
  return next(specifier, context);
} });
const dom = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createTestQueryClient, settleQueries } = await import("#web/lib/query/test-client.ts");
const { QueryProvider } = await import("#web/lib/query/provider.tsx");
const { CurveTradeSetupContext } = await import("#web/components/launchpad/trade/curve-trade-context.ts");
const { CurveLaunchTrade } = await import("./CurveLaunchTrade");
const { queryKeys } = await import("#web/lib/query/keys.ts");
type Setup = import("#web/components/launchpad/trade/server-availability.ts").CurveTradeSetup;
type CoinRecord = import("./coin-reads").CoinRecord;

const config = { network: "mainnet" as const, mode: "production" as const, baseUrl: "http://127.0.0.1:1", manifest: BLAST_DEPLOYMENTS.mainnet! };
const connection = { privyAppId: null, nonce: "" };
const available: Setup = { availability: { status: "available", config }, connection };
const unavailable: Setup = { availability: { status: "unavailable", reason: "Trading is paused." }, connection };
const asset = (coin_type: string) => ({ chain: "sui", network: "mainnet", coin_type, presale_id: null }) as const;
const coin = (coin_type: string, lifecycle?: string) => ({ coin_type, symbol: "C", name: "Coin", decimals: 9, price_usd: null, lifecycle }) as CoinRecord;

const client = createTestQueryClient();

async function rendered(setup: Setup | null, coinType: string, lifecycle?: string): Promise<HTMLElement> {
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(
    <QueryProvider client={client}>
      <CurveTradeSetupContext value={setup}>
        <CurveLaunchTrade asset={asset(coinType)} coin={coin(coinType, lifecycle)} visible>
          <p data-aggregator-box="">aggregator</p>
        </CurveLaunchTrade>
      </CurveTradeSetupContext>
    </QueryProvider>,
  ));
  test.after(async () => { await act(async () => root.unmount()); container.remove(); });
  return container;
}

test("a coin on its bonding curve opens the curve rail for its launch", async () => {
  const container = await rendered(available, "0x1::curve::CURVE");
  await waitFor(() => container.textContent === "curve-rail:0xlaunch:true", "curve rail");
});

test("a curve coin where trading is off here shows the reason instead of the aggregator box", async () => {
  const container = await rendered(unavailable, "0x1::curve::CURVE");
  const notice = await waitFor(() => container.querySelector("[data-trade-unavailable]"), "unavailable reason");
  assert.match(notice.textContent!, /Trading is paused\./);
  assert.equal(container.querySelector("[data-aggregator-box]"), null);
});

test("graduated, migrated and unconfigured coins keep the aggregator box", async () => {
  const graduated = await rendered(available, "0x1::grad::GRAD");
  const migrated = await rendered(available, "0x1::curve::CURVE", "migrated");
  const unconfigured = await rendered(null, "0x1::curve::CURVE");
  // The graduated coin's launch read has answered (no curve) before the boxes are checked.
  await waitFor(() => client.getQueryData(queryKeys.workspace.curveLaunch("mainnet", "0x1::grad::GRAD")) === null && client.isFetching() === 0, "launch read answered");
  for (const container of [graduated, migrated, unconfigured]) {
    assert.equal(container.textContent, "aggregator");
  }
});

test("a curve that migrates hands over to the aggregator box, and a later failed read keeps it there", async () => {
  const pools = (globalThis as unknown as { curvePools: Record<string, string | null | Error> }).curvePools;
  const coinType = "0x1::moving::MOVING";
  const key = queryKeys.workspace.curveLaunch("mainnet", coinType);
  // The observers hear of a finished read on a later macrotask, so the panel has redrawn once the queries settle.
  const settled = async (status: "success" | "error") => {
    await waitFor(() => client.getQueryState(key)?.status === status, `launch read ${status}`);
    await act(async () => settleQueries(client));
  };
  pools[coinType] = "0xmoving";
  const container = await rendered(available, coinType);
  await waitFor(() => container.textContent === "curve-rail:0xmoving:true", "curve rail");

  // A failed read after an answer keeps that answer.
  pools[coinType] = new Error("indexer down");
  await act(async () => client.invalidateQueries({ queryKey: key }).catch(() => {}));
  await settled("error");
  assert.equal(container.textContent, "curve-rail:0xmoving:true");

  // The indexer answers "no curve": the coin migrated.
  pools[coinType] = null;
  await act(async () => client.invalidateQueries({ queryKey: key }));
  await waitFor(() => container.textContent === "aggregator", "aggregator after migration");

  // A failed read after that answer never brings the dead curve rail back.
  pools[coinType] = new Error("indexer down");
  await act(async () => client.invalidateQueries({ queryKey: key }).catch(() => {}));
  await settled("error");
  assert.equal(container.textContent, "aggregator");
});

test("a coin opened from Bonding keeps its curve rail when the first launch read fails", async () => {
  const globals = globalThis as unknown as { curvePools: Record<string, string | null | Error>; curveSeeds: Record<string, string> };
  const coinType = "0x1::fresh::FRESH";
  globals.curveSeeds[coinType] = "0xfresh";
  globals.curvePools[coinType] = new Error("indexer down");
  const container = await rendered(available, coinType);
  await waitFor(() => client.getQueryState(queryKeys.workspace.curveLaunch("mainnet", coinType))?.status === "error", "launch read error");
  await act(async () => settleQueries(client));
  assert.equal(container.textContent, "curve-rail:0xfresh:true");
});
