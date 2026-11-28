import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";

// The viewer and the portfolio read stand in for the app's: the test sets who is signed in and counts the reads.
const viewer = "export const useSocialViewer = () => globalThis.viewer;";
const queries = `export function portfolioQuery() {
  return { queryKey: ["blast", "me", "portfolio", "holdings"], queryFn: async () => { globalThis.reads += 1; return globalThis.portfolio; } };
}`;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith("/bonding/HolderLine.tsx")) {
    if (specifier === "#web/components/social/SignInGate.tsx") return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(viewer)}` };
    if (specifier === "#web/components/social/queries.ts") return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(queries)}` };
  }
  return next(specifier, context);
} });
const dom = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createTestQueryClient } = await import("#web/lib/query/test-client.ts");
const { QueryProvider } = await import("#web/lib/query/provider.tsx");
const { invalidateAfter } = await import("#web/lib/query/invalidate.ts");
const { ChartMarketCapSupply } = await import("#web/components/launchpad/chart/chart-market-cap.ts");
const { HeldBalanceProvider, usePublishHeldBalance } = await import("#web/components/launchpad/trade/held-balance.tsx");
const { HolderLine } = await import("./HolderLine.tsx");

const COIN = "0x2::nogas::NOGAS";
const world = globalThis as unknown as { viewer: unknown; reads: number; portfolio: unknown };
world.portfolio = {
  wallet_sync: { status: "ready" },
  coins: [{ coin_type: COIN, balance: "10", basis_usd: "1", basis_complete: true, pnl_usd: null, pnl_multiple: null }],
};

function Rail({ atoms }: Readonly<{ atoms: bigint | null }>) {
  usePublishHeldBalance(atoms);
  return null;
}

async function mount(signedIn: boolean, atoms: bigint | null) {
  world.viewer = signedIn ? { signedIn, callsign: "me", getAccessToken: async () => "token" } : { signedIn, callsign: null };
  world.reads = 0;
  const client = createTestQueryClient();
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  test.after(async () => { await act(async () => root.unmount()); container.remove(); client.clear(); });
  const render = (next: bigint | null) => act(async () => root.render(<QueryProvider client={client}><HeldBalanceProvider>
    <ChartMarketCapSupply value={{ atoms: "1000", decimals: 0 }}><HolderLine coinType={COIN} capUsd="1000" /></ChartMarketCapSupply>
    <Rail atoms={next} />
  </HeldBalanceProvider></QueryProvider>));
  await render(atoms);
  return { client, container, render };
}

test("a signed-in holder reads the portfolio once per open, and once more after their own trade", async () => {
  const { client, container, render } = await mount(true, 10n);
  assert.equal(world.reads, 1);
  assert.match(container.textContent ?? "", /^In at \$100/);
  await render(10n);
  assert.equal(world.reads, 1);
  await act(async () => invalidateAfter(client, { kind: "trade" }));
  assert.equal(world.reads, 2);
});

test("nothing is read for a signed-out viewer, a non-holder, or before the rail knows the balance", async () => {
  await mount(false, 10n);
  assert.equal(world.reads, 0);
  const { render } = await mount(true, 0n);
  assert.equal(world.reads, 0);
  await render(null);
  assert.equal(world.reads, 0);
});
