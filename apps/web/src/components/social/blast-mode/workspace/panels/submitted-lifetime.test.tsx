import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { installTestDom, testEvent } from "../../../../../../test/fixtures/social/test-dom.ts";
import { createTransactionProvider } from "../../../../../../test/fixtures/workspace/transactions/provider.ts";
const dom = installTestDom();
dom.window.reducedMotion = true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
const { SocialViewerProvider } = await import("../../../SignInGate");
const { ToastProvider } = await import("#web/components/blast-ui/Toasts.tsx");
const { toast } = await import("sonner");
const authFixture = new URL("../../../../../../test/fixtures/workspace/acceptance-auth-stub.tsx", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/\/(?:trade\/TradeHost|commit\/CommitHost)\.tsx$/.test(context.parentURL ?? "") &&
      (specifier.endsWith("/PrivySessionProvider.tsx") || specifier === "../coins/signers")) {
      return { shortCircuit: true, url: authFixture };
    }
    return nextResolve(specifier, context);
  },
});
const { LifetimeSurface } = await import("../../../../../../test/fixtures/workspace/transactions/LifetimeFixture.tsx");
const { createTestQueryClient, withQueryClient } = await import("#web/lib/query/test-client.ts");
const { queryKeys } = await import("#web/lib/query/keys.ts");
const router = { bfcacheId: "test", push() {}, replace() {}, prefetch() {}, back() {}, forward() {}, refresh() {}, hmrRefresh() {} };
const accountTokens = { original: async () => "fixture-original-owner", changed: async () => "fixture-changed-owner" };
const pause = () => new Promise<void>((r) => setTimeout(r, 25));
async function waitFor(check: () => boolean, description: string) {
  for (let count = 0; count < 100; count++) { if (check()) return; await act(pause); }
  assert.fail(description);
}

for (const outcome of ["confirmed", "unknown", "cancelled"] as const) {
for (const action of ["buy", "sell", "commit"] as const) {
  test(`${action}/${outcome}: the production shell keeps the true outcome across workspace presentation changes`, async (t) => {
    const provider = createTransactionProvider();
    provider.setMode(outcome);
    t.mock.method(globalThis, "fetch", provider.fetch);
    const client = createTestQueryClient({ queries: { gcTime: Infinity } });
    client.setQueryData([...queryKeys.me.transactions.all, "lifetime"], { rows: [] });
    client.setQueryData(queryKeys.presales.detail(provider.detail.presale.presale_id), provider.detail);
    const container = dom.document.createElement("div"); dom.document.body.append(container);
    const root = createRoot(container);
    let account: keyof typeof accountTokens = "original";
    const render = () => root.render(withQueryClient(client, <AppRouterContext value={router}><SocialViewerProvider signedIn callsign={account} getAccessToken={accountTokens[account]}><ToastProvider><LifetimeSurface provider={provider} /></ToastProvider></SocialViewerProvider></AppRouterContext>));
    const click = async (text: string) => { const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === text); assert.ok(button, text); await act(async () => button.click()); };
    const present = async (value: string) => { const select = container.querySelector<HTMLSelectElement>('[aria-label="Presentation"]')!; await act(async () => { select.value = value; select.dispatchEvent(testEvent("change")); }); };
    t.after(async () => { provider.finish(); await act(async () => root.unmount()); container.remove(); client.clear(); });
    await act(async () => render());
    if (action === "commit") await click("Presale");
    if (action === "sell") await click("Sell");
    const submit = () => container.querySelector<HTMLButtonElement>(action === "commit" ? "[data-presale-submit]" : "[data-coin-submit]");
    await waitFor(() => !!submit() && !submit()!.disabled, "real panel quote must be actionable");
    assert.equal(provider.counts.executes, 0);
    const noticeBefore = new Set(toast.getToasts().map((notice) => notice.id));
    await act(async () => { submit()!.click(); submit()!.click(); });
    await waitFor(() => outcome === "cancelled" ? provider.counts.signs === 1 : provider.counts.executes === 1, "existing flow must reach the controlled signature/execution boundary");
    assert.equal(provider.counts.signs, 1);
    assert.equal(provider.counts.builds, 1);
    for (const operation of ["hide", "displace", "remove", "mobile", "Data", "exit", "lifecycle", "visible"]) await present(operation);
    await click("Change current account UI");
    account = "changed";
    await act(async () => render());
    assert.equal(provider.counts.executes, outcome === "cancelled" ? 0 : 1, "none of the non-submit operations executes");
    const persisted = container.querySelector("[data-setup]")!.textContent!;
    assert.doesNotMatch(persisted, /q1\.lifetime_quote|transaction_bytes|digest|preparing|signing|executing/);
    await present("remove");
    await act(async () => { provider.finish(); });
    if (outcome === "unknown" && action !== "commit") {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 9000)));
    }
    if (outcome === "cancelled" && action === "commit") {
      assert.equal(provider.counts.executes, 0);
      return;
    }
    await waitFor(() => provider.counts.moved === 1, "shell balance invalidation survives origin removal");
    assert.equal(provider.counts.executes, outcome === "cancelled" ? 0 : 1);
    assert.equal(toast.getToasts().filter((notice) => !noticeBefore.has(notice.id)).length, outcome === "cancelled" ? 0 : 1, "shell outcome notice appears once for confirmed or pending execution");
    verifyOutcome(provider, action, outcome, client);
    assert.ok(provider.writes.length > 0);
    assert.ok(provider.writes.every((write) => write.authorization === "Bearer fixture-original-owner"), "the original API owner continues execution and settlement after account UI changes");
    await present("visible");
    await act(async () => root.unmount());
    const refreshed = createRoot(container);
    await act(async () => refreshed.render(withQueryClient(client, <AppRouterContext value={router}><SocialViewerProvider signedIn callsign={account} getAccessToken={accountTokens[account]}><ToastProvider><LifetimeSurface provider={provider} /></ToastProvider></SocialViewerProvider></AppRouterContext>)));
    await act(pause);
    assert.equal(provider.counts.executes, outcome === "cancelled" ? 0 : 1, "refresh only restores display; it never re-arms a write");
    await act(async () => refreshed.unmount());
  });
}
}

function verifyOutcome(provider: ReturnType<typeof createTransactionProvider>, action: string, outcome: string, client: ReturnType<typeof createTestQueryClient>) {
    if (action === "commit") {
      assert.equal(provider.counts.intents, 1);
      assert.equal(provider.intents[0]?.status, outcome === "confirmed" ? "confirmed" : "pending", "existing flow registered its digest before execution");
      assert.equal(client.getQueryState([...queryKeys.me.transactions.all, "lifetime"]), undefined, "account changes still clear the prior private cache");
      assert.equal(client.getQueryState(queryKeys.presales.detail(provider.detail.presale.presale_id))?.isInvalidated, true);
      assert.match(provider.intents[0]!.digest, /^[1-9A-HJ-NP-Za-km-z]{40,50}$/);
    } else {
      assert.deepEqual([...provider.trades.values()].map((trade) => trade.status), [outcome === "confirmed" ? "confirmed" : "built"]);
      assert.equal(provider.counts.settles, outcome === "confirmed" ? 1 : outcome === "unknown" ? 5 : 0, "existing trade flow settles by its existing recovery policy");
    }

}
