import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { BLAST_DEPLOYMENTS } from "@interest-protocol/blast-sdk/deployments";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";

// The rail and the sheet stand in for the coin page's: the rail records its props and whether it is mounted, the
// sheet shows its rails only while open and hands its close and closed calls to the test.
const react = import.meta.resolve("react");
const rail = `import { useEffect } from ${JSON.stringify(react)};
export function StandaloneCurveTrade(props) {
  (globalThis.rails ??= {})[props.launchId] = props;
  useEffect(() => { (globalThis.mounted ??= new Set()).add(props.launchId); return () => globalThis.mounted.delete(props.launchId); }, [props.launchId]);
  return "rail:" + props.launchId;
}`;
const sheet = `import { createElement } from ${JSON.stringify(react)};
export function TradeSheet(props) {
  globalThis.sheet = props;
  return props.open ? createElement("section", { "data-sheet": props.title }, props.children) : null;
}`;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith("/coins/CurveBuySheet.tsx")) {
    if (specifier === "#web/components/launchpad/trade/CoinTrade.tsx") return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(rail)}` };
    if (specifier === "#web/components/launchpad/trade/TradeSheet.tsx") return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(sheet)}` };
  }
  return next(specifier, context);
} });
const dom = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { CurveBuySheet } = await import("./CurveBuySheet");
type Request = import("./CurveBuySheet").CurveBuyRequest;
type Coin = import("@blast/core/modules/social/contracts/trades.ts").SocialTradeCoin;
type RailProps = Readonly<{ onHeldChange: (held: boolean) => void; onMigrated: () => void }>;
type SheetProps = Readonly<{ open: boolean; onClose: () => void; onClosed: () => void }>;

const world = globalThis as unknown as { rails: Record<string, RailProps>; mounted: Set<string>; sheet: SheetProps };
const config = { network: "mainnet" as const, mode: "production" as const, baseUrl: "http://127.0.0.1:1", manifest: BLAST_DEPLOYMENTS.mainnet! };
const setup = { availability: { status: "available", config }, connection: { privyAppId: null, nonce: "" } } as const;
const coin = (symbol: string): Coin => ({ coin_type: `0x1::${symbol.toLowerCase()}::${symbol}`, symbol, name: symbol, decimals: 9, icon_url: null, usd_price: null, presale_id: null, launch_id: `0x${symbol.toLowerCase()}` });
const buy = (symbol: string, seq: number): Request => ({ buy: { launchId: `0x${symbol.toLowerCase()}`, coin: coin(symbol) }, seq });

async function mount() {
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container);
  const graduated: Coin[] = [];
  const show = (request: Request) => act(async () => root.render(<CurveBuySheet request={request} setup={setup} onGraduated={next => graduated.push(next)} />));
  test.after(async () => { await act(async () => root.unmount()); container.remove(); });
  return { container, graduated, show };
}

test("a pending buy keeps its rail when another coin's Buy opens, and goes once it settles", async () => {
  const { container, show } = await mount();
  await show(buy("AAA", 1));
  assert.equal(container.querySelector("[data-sheet]")?.getAttribute("data-sheet"), "Buy $AAA");
  assert.equal(container.textContent, "rail:0xaaa");

  await act(async () => world.rails["0xaaa"]!.onHeldChange(true));
  await show(buy("BBB", 2));
  assert.equal(container.querySelector("[data-sheet]")?.getAttribute("data-sheet"), "Buy $BBB");
  assert.equal(container.textContent, "rail:0xbbb");
  assert.deepEqual([...world.mounted].sort(), ["0xaaa", "0xbbb"]);

  await act(async () => world.rails["0xaaa"]!.onHeldChange(false));
  assert.deepEqual([...world.mounted], ["0xbbb"]);

  // Closing with nothing held drops the rail once the sheet has gone; the next press mounts it again.
  await act(async () => world.sheet.onClose());
  assert.deepEqual([...world.mounted], ["0xbbb"]);
  await act(async () => world.sheet.onClosed());
  assert.equal(world.mounted.size, 0);
  await show(buy("BBB", 3));
  assert.equal(container.textContent, "rail:0xbbb");
});

test("the open coin's graduation hands it to the swap; a closed one is just dropped", async () => {
  const { graduated, show } = await mount();
  await show(buy("CCC", 1));
  await act(async () => world.rails["0xccc"]!.onHeldChange(true));
  await show(buy("DDD", 2));
  await act(async () => world.rails["0xccc"]!.onMigrated());
  assert.equal(graduated.length, 0);
  assert.equal(world.mounted.has("0xccc"), false);

  await act(async () => world.rails["0xddd"]!.onMigrated());
  assert.deepEqual(graduated.map(next => next.symbol), ["DDD"]);
  assert.equal(world.sheet.open, false);
  assert.equal(world.mounted.has("0xddd"), false);
});
