import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { installTestDom, waitFor } from "../../../../../../test/fixtures/social/test-dom.ts";

// The coin page's lists stand in as text naming what they were given; the launch and curve reads answer from tables.
const stubs: Record<string, string> = {
  "#web/components/launchpad/activity/CoinActivity.tsx": `export const CoinActivity = ({ source: s }) => "trades:" + s.launchId + ":" + s.units.symbol + ":" + s.units.memeDecimals + ":" + s.units.quoteSymbol + ":" + s.units.quoteDecimals + (s.units.quoteUsd ? ":usd=" + s.units.quoteUsd : "") + (s.livePools ? ":live=" + s.livePools.join(",") : "");`,
  "#web/components/launchpad/holders/CoinHolders.tsx": `export const CoinHolders = ({ source: s }) => "holders:" + s.launchId + ":" + s.coinType + ":" + s.symbol + ":" + s.decimals;`,
  "#web/components/launchpad/theses/ThesesBoard.tsx": `export const ThesesBoard = p => "theses:" + p.launchId + ":" + p.symbol + ":" + (p.composer(() => {}) ?? "read-only");`,
  "./curve-launch": `const pools = { "0x1::curve::CURVE": "0xlaunch" };
const units = globalThis.curveUnits ??= { "0xlaunch": { quoteType: "0x2::sui::SUI", quoteDecimals: 9, memeDecimals: 6, price: "123", quoteUsd: "3.4521" } };
export const mayTradeOnCurve = (asset, coin) => asset.network === "mainnet" && asset.presale_id === null && asset.coin_type !== "0x2::sui::SUI" && coin?.lifecycle !== "migrated";
export const curveLaunchQuery = (client, asset) => ({ queryKey: ["blast", "public", "workspace-curve-launch", asset.network, asset.coin_type], queryFn: async () => pools[asset.coin_type] ?? null });
export const curvePoolQuery = launchId => ({ queryKey: ["blast", "public", "workspace-curve-pool", launchId], queryFn: async () => { const value = units[launchId]; if (value instanceof Error) throw value; return value; } });`,
};
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith("/panels/CurveLaunchLists.tsx") && specifier in stubs) {
    return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(stubs[specifier]!)}` };
  }
  return next(specifier, context);
} });
const dom = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createTestQueryClient } = await import("#web/lib/query/test-client.ts");
const { QueryProvider } = await import("#web/lib/query/provider.tsx");
const { CurveHolders, CurveTheses, CurveTrades, useCurveListLaunch, useCurveQuotePrice } = await import("./CurveLaunchLists");
type CoinAsset = import("./coin-reads").CoinAsset;
type CoinRecord = import("./coin-reads").CoinRecord;

const asset = (coin_type: string, presale_id: string | null = null): CoinAsset => ({ chain: "sui", network: "mainnet", coin_type, presale_id });
const coin = (coin_type: string, lifecycle?: string) => ({ coin_type, symbol: "FROG", name: "Frog", decimals: 6, price_usd: null, lifecycle }) as CoinRecord;

async function rendered(node: React.ReactNode, client = createTestQueryClient()): Promise<HTMLElement> {
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(
    <QueryProvider client={client}>
      {node}
    </QueryProvider>,
  ));
  test.after(async () => { await act(async () => root.unmount()); container.remove(); });
  return container;
}

function Launch({ asset, coin }: Readonly<{ asset: CoinAsset; coin: CoinRecord | null }>) {
  return <>{`launch:${useCurveListLaunch(asset, coin, true) ?? "none"}`}</>;
}

test("a coin on its bonding curve names its launch; presale, migrated and other coins name none", async () => {
  // One client: the curve's answer is already cached when the others render, so only their own rules keep it out.
  const client = createTestQueryClient();
  const curve = await rendered(<Launch asset={asset("0x1::curve::CURVE")} coin={coin("0x1::curve::CURVE")} />, client);
  await waitFor(() => curve.textContent === "launch:0xlaunch", "curve launch");
  const other = await rendered(<Launch asset={asset("0x1::other::OTHER")} coin={coin("0x1::other::OTHER")} />, client);
  await waitFor(() => client.getQueryState(["blast", "public", "workspace-curve-launch", "mainnet", "0x1::other::OTHER"])?.status === "success", "other read");
  const others = [
    other,
    await rendered(<Launch asset={asset("0x1::curve::CURVE", "0xpresale")} coin={coin("0x1::curve::CURVE")} />, client),
    await rendered(<Launch asset={asset("0x1::curve::CURVE")} coin={coin("0x1::curve::CURVE", "migrated")} />, client),
  ];
  for (const container of others) assert.equal(container.textContent, "launch:none");
});

test("curve trades show the launch's activity in its own quote coin and decimals", async () => {
  const container = await rendered(<CurveTrades launchId="0xlaunch" asset={asset("0x1::curve::CURVE")} coin={coin("0x1::curve::CURVE")} visible />);
  await waitFor(() => container.textContent === "trades:0xlaunch:FROG:6:SUI:9:usd=3.4521", "curve trades");
});

test("only the focused coin's trades follow the curve's market stream; compare cards poll", async () => {
  const focused = await rendered(<CurveTrades launchId="0xlaunch" asset={asset("0x1::curve::CURVE")} coin={coin("0x1::curve::CURVE")} visible live />);
  await waitFor(() => focused.textContent === "trades:0xlaunch:FROG:6:SUI:9:usd=3.4521:live=blast_curve:0xlaunch", "live curve trades");
  const compared = await rendered(<CurveTrades launchId="0xlaunch" asset={asset("0x1::curve::CURVE")} coin={coin("0x1::curve::CURVE")} visible />);
  await waitFor(() => compared.textContent === "trades:0xlaunch:FROG:6:SUI:9:usd=3.4521", "polled curve trades");
});

test("a failed curve read offers a retry instead of guessing the quote coin", async () => {
  const units = (globalThis as unknown as { curveUnits: Record<string, unknown> }).curveUnits;
  units["0xbroken"] = new Error("down");
  const container = await rendered(<CurveTrades launchId="0xbroken" asset={asset("0x1::curve::CURVE")} coin={null} visible />);
  const retry = await waitFor(() => container.querySelector("button"), "retry button");
  assert.equal(retry.textContent, "Retry trades");
  assert.doesNotMatch(container.textContent!, /trades:/);
});

test("curve holders and theses read the launch, theses without a post form", async () => {
  const holders = await rendered(<CurveHolders launchId="0xlaunch" asset={asset("0x1::curve::CURVE")} coin={coin("0x1::curve::CURVE")} visible />);
  assert.equal(holders.textContent, "holders:0xlaunch:0x1::curve::CURVE:FROG:6");
  const theses = await rendered(<CurveTheses launchId="0xlaunch" coin={coin("0x1::curve::CURVE")} visible />);
  assert.equal(theses.textContent, "theses:0xlaunch:FROG:read-only");
});

test("hidden curve lists mount nothing, so nothing polls", async () => {
  const c = coin("0x1::curve::CURVE");
  const a = asset("0x1::curve::CURVE");
  const client = createTestQueryClient();
  const container = await rendered(<>
    <CurveTrades launchId="0xlaunch" asset={a} coin={c} visible={false} />
    <CurveHolders launchId="0xlaunch" asset={a} coin={c} visible={false} />
    <CurveTheses launchId="0xlaunch" coin={c} visible={false} />
  </>, client);
  assert.equal(container.textContent, "");
  assert.equal(client.getQueryCache().getAll().length, 0);
});

function QuotePrice({ launchId, enabled }: Readonly<{ launchId: string | null | undefined; enabled: boolean }>) {
  const quote = useCurveQuotePrice(launchId, enabled);
  return <>{quote === undefined ? "pending" : quote === null ? "none" : `${quote.price} ${quote.symbol}`}</>;
}

test("the quote price waits while the launch is pending instead of showing none", async () => {
  const pending = await rendered(<QuotePrice launchId={undefined} enabled />);
  assert.equal(pending.textContent, "pending");
});

test("a failed price re-read keeps the Trades list and the last price", async () => {
  const units = (globalThis as unknown as { curveUnits: Record<string, unknown> }).curveUnits;
  units["0xflaky"] = { quoteType: "0x2::sui::SUI", quoteDecimals: 9, memeDecimals: 6, price: "123" };
  const client = createTestQueryClient();
  const container = await rendered(<>
    <CurveTrades launchId="0xflaky" asset={asset("0x1::curve::CURVE")} coin={coin("0x1::curve::CURVE")} visible />
    {" | "}
    <QuotePrice launchId="0xflaky" enabled />
  </>, client);
  await waitFor(() => container.textContent === "trades:0xflaky:FROG:6:SUI:9 | 0.123 SUI", "loaded");
  units["0xflaky"] = new Error("down");
  await act(async () => { await client.refetchQueries({ queryKey: ["blast", "public", "workspace-curve-pool", "0xflaky"] }); });
  await waitFor(() => client.getQueryState(["blast", "public", "workspace-curve-pool", "0xflaky"])?.status === "error", "failed re-read");
  assert.equal(container.textContent, "trades:0xflaky:FROG:6:SUI:9 | 0.123 SUI");
});

test("an unpriced curve coin's price reads in its quote coin, per whole coin", async () => {
  const units = (globalThis as unknown as { curveUnits: Record<string, unknown> }).curveUnits;
  units["0xtsui"] = { quoteType: "0x963331df9a26c8674c33eb97655fe44807d5ff1aa4092bcbe2bdbe044b17b03d::test_sui::TEST_SUI", quoteDecimals: 9, memeDecimals: 9, price: "0.000012345" };
  const tsui = await rendered(<QuotePrice launchId="0xtsui" enabled />);
  await waitFor(() => tsui.textContent === "0.000012345 TSUI", "TSUI price");
  // 123 SUI atoms per meme atom, 6 meme decimals against 9 quote decimals: 0.123 SUI per coin.
  const sui = await rendered(<QuotePrice launchId="0xlaunch" enabled />);
  await waitFor(() => sui.textContent === "0.123 SUI", "SUI price");
});

test("the quote price falls back to none on a failed read or a curve with no price, and reads nothing when off", async () => {
  const units = (globalThis as unknown as { curveUnits: Record<string, unknown> }).curveUnits;
  units["0xdown"] = new Error("down");
  units["0xempty"] = { quoteType: "0x2::sui::SUI", quoteDecimals: 9, memeDecimals: 6, price: null };
  const down = await rendered(<QuotePrice launchId="0xdown" enabled />);
  await waitFor(() => down.textContent === "none", "failed read");
  const empty = await rendered(<QuotePrice launchId="0xempty" enabled />);
  await waitFor(() => empty.textContent === "none", "no price");
  const client = createTestQueryClient();
  const off = await rendered(<><QuotePrice launchId="0xlaunch" enabled={false} /><QuotePrice launchId={null} enabled /></>, client);
  assert.equal(off.textContent, "nonenone");
  assert.equal(client.getQueryCache().getAll().filter((query) => query.state.fetchStatus !== "idle" || query.state.dataUpdatedAt > 0).length, 0);
});
