import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { BLAST_DEPLOYMENTS } from "@interest-protocol/blast-sdk/deployments";
import type { CoinPage } from "@blast/core/modules/launchpad-coin/contracts.ts";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";
import { sessions } from "../../../../test/fixtures/launchpad/trade/session-fixture.tsx";

const hostFixtureUrl = `data:text/javascript,${encodeURIComponent(`import {useState} from ${JSON.stringify(import.meta.resolve("react"))}; let mounts = 0; export const CoinsHost = props => { const [instance] = useState(() => ++mounts); return JSON.stringify({...props, instance}); };`)}`;
const fixtureUrl = import.meta.resolve("../../../../test/fixtures/launchpad/trade/session-fixture.tsx");
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "./CurveTradeProvider" && context.parentURL?.endsWith("/trade/CoinTrade.tsx")) return { shortCircuit: true, url: fixtureUrl };
  if (specifier === "#web/components/social/coins/CoinsHost.tsx" && context.parentURL?.endsWith("/trade/CoinTrade.tsx")) return { shortCircuit: true, url: hostFixtureUrl };
  if (specifier === "next/navigation") return { shortCircuit: true, url: "data:text/javascript,export const useRouter = () => ({ refresh() {} }); export const usePathname = () => '/coin/fixture';" };
  return next(specifier, context);
} });
const dom = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { CoinTradeExecution, CoinTrade } = await import("./CoinTrade");
const { CoinExecution } = await import("../coin/CoinExecution");

const config = { network: "mainnet" as const, mode: "production" as const, baseUrl: "http://127.0.0.1:1", manifest: BLAST_DEPLOYMENTS.mainnet! };
const connection = { nonce: "", privyAppId: null, migrationPosition: null };
const page = (availability: CoinPage["availability"]) => ({ launchId: "0x1", fresh: { status: "unavailable", reason: "Fixture read" }, availability }) as CoinPage;

test("a degraded refresh and a lifecycle change preserve an ambiguous digest and block replacement sessions", async () => {
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container);
  const render = (availability: CoinPage["availability"]) => act(async () => {
    const current = page(availability);
    root.render(<CoinTradeExecution page={current} availability={{ status: "available", config }} connection={connection}>
      <CoinExecution page={current} actions={{ trade: () => <CoinTrade /> }} />
    </CoinTradeExecution>);
  });
  try {
    await render({ kind: "curve" });
    const first = sessions[0]!;
    await act(async () => first.buy.ambiguous());
    assert.match(container.textContent!, /retained-fixture-digest/);
    await render({ kind: "unverified", reason: "Node did not answer" });
    assert.match(container.textContent!, /retained-fixture-digest/);
    await render({ kind: "curve" });
    assert.equal(sessions.length, 1, "recovery uses the original controllers");
    assert.match(container.textContent!, /retained-fixture-digest/);
    await render({ kind: "venue", poolKey: "bluefin:0x2", route: { venue: "bluefin", tickSpacing: 60, feeRate: 3000n, supported: true, reason: null } });
    assert.match(container.textContent!, /retained-fixture-digest/);
    assert.equal(container.querySelectorAll("[data-coin-trade]").length, 1, "one reconciliation rail survives migration");
    const recheck = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Check transaction")!;
    await act(async () => recheck.click());
    assert.deepEqual(first.buy.counts(), { rechecks: 1, submissions: 0 });
    assert.equal(sessions.length, 1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});


test("the graduated coin outlet embeds the shared Blast swap with the page coin selected", async () => {
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container);
  const current = { ...page({ kind: "venue", poolKey: "bluefin:0x2", route: { venue: "bluefin", tickSpacing: 60, feeRate: 3000n, supported: true, reason: null } }),
    curve: { state: "available", data: { launch: { coinType: "0x123::graduated::GRAD", metadata: { name: "Graduated", symbol: "GRAD", iconUrl: null }, economics: { inputs: { memeDecimals: 9n } } } } },
    coin: { state: "available", data: { decimals: 9 } },
  } as unknown as CoinPage;
  try {
    await act(async () => root.render(<CoinTradeExecution page={current} availability={{ status: "available", config }} connection={connection}><CoinTrade /></CoinTradeExecution>));
    const { instance, ...opening } = JSON.parse(container.textContent!);
    assert.deepEqual(opening, {
      active: true,
      inlineTrade: { side: "buy", coin: { coin_type: "0x123::graduated::GRAD", name: "Graduated", symbol: "GRAD", decimals: 9, icon_url: null, usd_price: null, presale_id: null } },
    });
    await act(async () => root.render(<CoinTradeExecution page={current} availability={{ status: "unavailable", reason: "Fixture unavailable" }} connection={connection}><CoinTrade /></CoinTradeExecution>));
    assert.equal(JSON.parse(container.textContent!).active, false, "loss of availability disables the retained shared host");
    const missing = { state: "unavailable", reason: "Fixture read" } as const;
    const degraded = { ...current, curve: missing, coin: missing };
    await act(async () => root.render(<CoinTradeExecution page={degraded} availability={{ status: "available", config }} connection={connection}><CoinTrade /></CoinTradeExecution>));
    const retained = JSON.parse(container.textContent!);
    assert.equal(retained.active, false, "missing refreshed metadata disables the existing host");
    assert.equal(retained.instance, instance, "the same mounted host retains its pending lock across metadata degradation");
    assert.equal(retained.inlineTrade.coin.coin_type, "0x123::graduated::GRAD", "metadata degradation preserves the host and its pending execution");
    await act(async () => root.render(<CoinTradeExecution page={current} availability={{ status: "available", config }} connection={connection}><CoinTrade /></CoinTradeExecution>));
    assert.equal(JSON.parse(container.textContent!).active, true);
    assert.equal(JSON.parse(container.textContent!).instance, instance, "metadata recovery never remounts the pending host");

  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
