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
  if (specifier === "#web/components/social/SignInGate.tsx" && /\/(bonding\/HolderLine|trade\/held-balance)\.tsx$/.test(context.parentURL ?? "")) {
    return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(viewer)}` };
  }
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

// A rail elsewhere on the page (a sale's sits in the shell's aside), reporting the coin in another spelling.
function Rail({ atoms }: Readonly<{ atoms: bigint | null }>) {
  usePublishHeldBalance("0x0000000000000000000000000000000000000000000000000000000000000002::nogas::NOGAS", atoms);
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

  // A sell of all of it: the rail reads nothing held, and the line goes even though the portfolio still lists the coin.
  await render(0n);
  assert.equal(container.textContent, "");
  // The rail stops reading (a phone sheet closes): the sell-all still stands.
  await render(null);
  assert.equal(container.textContent, "");
  assert.equal(world.reads, 2);
});

test("another account starts with no balance, so nothing is read for it until its own rail reads", async () => {
  const { container, render } = await mount(true, 10n);
  assert.equal(world.reads, 1);
  world.viewer = { signedIn: true, callsign: "other", getAccessToken: async () => "token" };
  await render(10n);
  assert.equal(container.textContent, "");
  assert.equal(world.reads, 1);
});

test("nothing is read for a signed-out viewer, a non-holder, or before the rail knows the balance", async () => {
  await mount(false, 10n);
  assert.equal(world.reads, 0);
  const { render } = await mount(true, 0n);
  assert.equal(world.reads, 0);
  await render(null);
  assert.equal(world.reads, 0);
});
