import assert from "node:assert/strict";
import test from "node:test";
import type { SocialMeAccount } from "@blast/core/modules/social/contracts/me.ts";
import type { SocialMePresales } from "@blast/core/modules/social/contracts/profile-page.ts";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";
installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
const { SocialAccountContext } = await import("../use-social-account.ts");
const { PortfolioScreen } = await import("./PortfolioScreen.tsx");
const { SocialViewerProvider } = await import("../SignInGate.tsx");
const { QueryProvider } = await import("#web/lib/query/provider.tsx");
const { createTestQueryClient } = await import("#web/lib/query/test-client.ts");
const { queryKeys } = await import("#web/lib/query/keys.ts");
const { portfolioPath, portfolioTabAt } = await import("#web/components/blast-ui/portfolio-navigation.ts");
const { setPortfolioTab } = await import("./portfolio-tab.ts");

test("the real screen keeps shared holdings and the balance header across Claims and history navigation", async (t) => {
  window.history.replaceState({}, "", "/portfolio");
  const client = createTestQueryClient();
  const holdings: SocialMePresales = {
    created: [], positions: [], watchlist: [], coins: [],
    vestings: [{
      schedule_id: "0x" + "01".repeat(32), total: "1000", claimed: "0", claimable: "0", claimable_usd: null,
      start_ms: 0, cliff_end_ms: 60_000, end_ms: 120_000, vested_pct: 0,
      presale: { presale_id: "0xabc", symbol: "TEST", name: "Test", icon_url: "", status: "open", venue: "cetus", start_ms: 0, end_ms: 120_000, fill_pct: 70, quote_symbol: "USDC", quote_decimals: 6, launched_ms: null, first_unlock_ms: null },
    }],
  };
  client.setQueryData(queryKeys.me.presales(true), holdings);
  const account: SocialMeAccount = {
    account_id: "priority-owner", kind: "new", callsign: "pilot", display_name: null, avatar_url: null,
    x_handle: null, verified: false, onboarding: { shown: true, completed: true }, privacy: "private",
    sharing_since_ms: null, wallets: [],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 503 });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove(); client.clear(); globalThis.fetch = originalFetch;
  });
  const router = { bfcacheId: "test", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, prefetch: async () => {} };
  await act(async () => root.render(<QueryProvider client={client}><AppRouterContext value={router}>
    <SocialAccountContext value={{ status: "ready", account, refresh() {} }}><SocialViewerProvider signedIn callsign="pilot">
      <PortfolioScreen nowMs={0} />
    </SocialViewerProvider></SocialAccountContext>
  </AppRouterContext></QueryProvider>));
  const hero = container.querySelector("#pfHero");
  assert.ok(hero);
  for (const tab of ["claims", "presales", "coins"] as const) {
    await act(async () => setPortfolioTab(tab));
    assert.equal(container.querySelector("#pfHero"), hero);
    assert.equal(client.getQueryCache().find({ queryKey: queryKeys.me.presales(true), exact: true })?.isActive(), true);
  }
  await act(async () => {
    window.history.replaceState({}, "", "/portfolio/claims");
    window.dispatchEvent(new window.PopStateEvent("popstate"));
  });
  assert.equal(container.querySelector("#pfHero"), hero);
  assert.equal(client.getQueryCache().find({ queryKey: queryKeys.me.presales(true), exact: true })?.isActive(), true);
});

test("all section destinations and legacy claim links are URL addressable", () => {
  for (const tab of ["coins", "presales", "claims"] as const) assert.equal(portfolioTabAt(portfolioPath(tab)), tab);
  assert.equal(portfolioTabAt("/portfolio", "?tab=vestings"), "claims");
  assert.equal(portfolioTabAt("/portfolio", "?tab=invalid"), "coins");
  assert.equal(portfolioTabAt("/vesting/new"), null);
});

test("a legacy claim link canonicalizes without a history entry, and tab links preserve the shell", async (t) => {
  window.history.replaceState({ nextField: "preserved" }, "", "/portfolio?tab=vestings");
  const before = window.history.length;
  const client = createTestQueryClient();
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); client.clear(); });
  const router = { bfcacheId: "test", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, prefetch: async () => {} };
  await act(async () => root.render(<QueryProvider client={client}><AppRouterContext value={router}><SocialAccountContext value={{ status: "signed_out", account: null, refresh() {} }}><PortfolioScreen nowMs={0} /></SocialAccountContext></AppRouterContext></QueryProvider>));
  assert.equal(window.location.pathname, "/portfolio/claims");
  assert.equal(window.location.search, "");
  assert.equal(window.history.length, before);
  const hero = container.querySelector("#pfHero");
  await act(async () => setPortfolioTab("presales"));
  assert.equal(window.location.pathname, "/portfolio/presales");
  assert.equal(window.history.length, before + 1);
  assert.equal(window.history.state.nextField, "preserved");
  assert.equal(container.querySelector("#pfHero"), hero);
  assert.equal(container.querySelector('[aria-selected="true"]')?.textContent, "Presales");
  // An old Vestings link reached by history still selects Claims, which replaced it.
  await act(async () => { window.history.replaceState({}, "", "/portfolio/vestings"); window.dispatchEvent(new window.PopStateEvent("popstate")); });
  assert.equal(container.querySelector('[aria-selected="true"]')?.textContent, "Claims");
});
