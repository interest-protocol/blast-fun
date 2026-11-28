import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { installTestDom, recordAnimations, setInputValue, testEvent } from "../../../../test/fixtures/social/test-dom.ts";
import { ALON_ID, ALON_READ, TSUI_TYPE } from "../../../../test/fixtures/social/commit/alon.ts";
import type { CommitResult } from "./commit-flow";
import type { CommitHostValue } from "./CommitHost";
import { QueryRefusal, QueryTransientError } from "#web/lib/query/client.ts";
import type { SocialWallet } from "@blast/core/modules/social/contracts/coins.ts";

declare global { var __contributionExecution: () => Promise<CommitResult>; }
const dom = installTestDom();
dom.window.reducedMotion = true;
const motion = recordAnimations();
const execution = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith("/social/commit/commit-run.ts")) return { format: "module", shortCircuit: true,
    source: `export async function runCommitFor(input) { input.onPhase?.("signing"); return globalThis.__contributionExecution(); }` };
  return nextLoad(url, context);
} });
const { act } = await import("react");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
const { SocialViewerProvider } = await import("../SignInGate");
const { SocialAccountContext } = await import("../use-social-account");
const { ToastProvider } = await import("#web/components/blast-ui/Toasts.tsx");
const { toast: sonner } = await import("sonner");
const { useCommitHost } = await import("./CommitHost");
const { createRoot } = await import("react-dom/client");
const { createTestQueryClient, withQueryClient } = await import("#web/lib/query/test-client.ts");
const { useBalances } = await import("../coins/balances");
const { walletBalanceRevision } = await import("#web/lib/query/invalidate.ts");
const { queryKeys } = await import("#web/lib/query/keys.ts");
const wallet: SocialWallet = { address: `0x${"a".repeat(64)}`, signer: "wallet", fee: "wallet", as_of_ms: 0,
  coins: [{ coin_type: TSUI_TYPE, symbol: "TSUI", name: "Test SUI", decimals: 9, atoms: "5000000000000", usd_price: null, value_usd: null, icon_url: null, presale: null }] };

// Real host, dialog, form, toast and reads; only signing/execution is replaced.
test("confirmed contributions toast once with or without a receipt sheet", async (t) => {
  t.mock.method(Date, "now", () => ALON_READ.presale.start_ms + 1_000);
  t.after(() => execution.deregister());
  let atoms = "5000000000000";
  let balanceReads = 0;
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL) => {
    const { pathname, searchParams } = new URL(String(url), "https://blast.test");
    if (pathname.endsWith("/viewer")) return Response.json({ presales: {} });
    if (!pathname.endsWith("/wallet")) return Response.json(ALON_READ);
    if (searchParams.get("identity") === "1") return Response.json({ ...wallet, coins: null });
    if (searchParams.get("balance_coin") === TSUI_TYPE) {
      balanceReads++;
      return Response.json({ address: wallet.address, coin_type: TSUI_TYPE, atoms, as_of_ms: Date.now() });
    }
    assert.fail("checkout must not ask for the wallet listing");
  });
  const client = createTestQueryClient();
  let host: CommitHostValue;
  let refreshes = 0;
  function Host() {
    const balances = useBalances(() => { refreshes++; throw new Error("refresh offline"); });
    host = useCommitHost({ presaleDeployed: true, balances });
    return <><button onClick={() => host.overlays.openCommitTo?.(ALON_ID, null)}>Blast</button>{host.node}</>;
  }
  const container = dom.document.createElement("div"); container.setAttribute("data-blast-ui", ""); dom.document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); client.clear(); });
  const router = { bfcacheId: "test", push() {}, replace() {}, prefetch() {}, back() {}, forward() {}, refresh() {}, hmrRefresh() {} };
  await act(async () => root.render(withQueryClient(client,
    <AppRouterContext value={router}><SocialAccountContext value={{ status: "signed_out", account: null, refresh() {} }}>
      <SocialViewerProvider signedIn callsign="kai" getAccessToken={async () => "test-access-token"}><ToastProvider><Host /></ToastProvider></SocialViewerProvider>
    </SocialAccountContext></AppRouterContext>)));
  const opener = container.querySelector<HTMLButtonElement>("button")!;
  const open = async () => { await act(async () => { opener.focus(); opener.click(); }); await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };
  const begin = async () => {
    const pending = Promise.withResolvers<CommitResult>();
    let calls = 0;
    globalThis.__contributionExecution = () => { calls++; return pending.promise; };
    const amount = container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
    assert.ok(amount, dom.document.body.innerHTML);
    await act(async () => { setInputValue(amount, "1000"); amount.dispatchEvent(testEvent("input")); });
    const buy = container.querySelector<HTMLButtonElement>('[data-kind="commit"] [data-ui-variant="primary"]')!;
    assert.ok(buy && !buy.disabled);
    await act(async () => { buy.click(); buy.click(); await new Promise((r) => setTimeout(r, 0)); });
    assert.equal(calls, 1, "two presses in one tick sign once");
    assert.equal(container.querySelector("[data-contribution-receipt]"), null);
    assert.match(container.textContent!, /Confirm in your wallet/);
    return pending;
  };
  const sent = (last: string): Extract<CommitResult, { status: "sent" }> => ({ status: "sent", digest: `4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLK${last}`, amount: "1000000000001", registered: true, why: null });
  const before = sonner.getToasts().length;
  await open();
  let pending = await begin();
  const readsBeforeRefusal = balanceReads;
  atoms = "950000000000";
  await act(async () => { pending.resolve({ status: "failed", code: "insufficient_balance", digest: null, message: "Your balance changed." }); });
  assert.equal(balanceReads, readsBeforeRefusal + 1);
  assert.equal(container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')?.value, "1000");
  assert.match(container.textContent!, /950 TSUI/);
  assert.equal(container.querySelector('[data-kind="commit"] [data-ui-variant="primary"]')?.textContent, "Add TSUI");
  atoms = "5000000000000";
  await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.me.wallet() }); });
  pending = await begin();
  const revisionBeforeConfirm = walletBalanceRevision(client);
  await act(async () => { pending.resolve(sent("i")); });
  assert.equal(walletBalanceRevision(client), revisionBeforeConfirm + 1, "one confirmation triggers one balance invalidation");
  const receipt = container.querySelector("[data-contribution-receipt]")!;
  assert.ok(receipt, "success replaces the form in the existing dialog");
  assert.match(receipt.textContent!, /You’re in!.*1,000.000000001 TSUI.*ALON.*confirmed/s);
  const explorerLink = receipt.querySelector<HTMLAnchorElement>('a[target="_blank"]');
  assert.equal(explorerLink?.href, "https://suiscan.xyz/mainnet/tx/" + sent("i").digest);
  assert.equal(explorerLink?.textContent, "View transaction");
  assert.equal(receipt.querySelector<HTMLAnchorElement>("a")?.getAttribute("href"), `/presale/${ALON_ID}`);
  assert.equal(sonner.getToasts().length, before + 1, "the open receipt sheet also gets a toast");
  assert.equal(refreshes, 1);
  assert.equal(dom.document.activeElement?.textContent, "Done");
  assert.equal(receipt.querySelectorAll('[role="status"]').length, 1);
  await act(async () => { await client.invalidateQueries(); });
  assert.ok(container.querySelector("[data-contribution-receipt]"), "refresh does not remove the receipt");
  await act(async () => { dom.document.dispatchEvent(testEvent("keydown", { key: "Escape" })); });
  await act(async () => motion.finishAll());
  assert.equal(container.querySelector("[data-contribution-receipt]"), null);
  assert.equal(dom.document.activeElement === opener, true, "Escape returns focus to the opener");

  await open(); pending = await begin();
  await act(async () => { dom.document.dispatchEvent(testEvent("keydown", { key: "Escape" })); });
  await act(async () => motion.finishAll());
  await act(async () => { pending.resolve(sent("j")); });
  assert.equal(container.querySelector("[data-contribution-receipt]"), null);
  assert.equal(sonner.getToasts().length, before + 2, "dismissed pending purchase toasts exactly once");

  await open(); pending = await begin();
  await act(async () => { host.overlays.openCommitTo?.(ALON_ID, null); });
  await act(async () => { pending.resolve(sent("k")); });
  assert.equal(container.querySelector("[data-contribution-receipt]"), null, "same-sale reopening is a new dialog");
  assert.ok(container.querySelector('input[inputmode="decimal"]'), "old success leaves the new form open");
  assert.equal(sonner.getToasts().length, before + 3);
  await act(async () => { host.overlays.openCommitTo?.(ALON_ID, null); });
  pending = await begin();
  await act(async () => { pending.resolve(sent("k")); });
  assert.equal(sonner.getToasts().length, before + 3, "the same confirmed digest cannot notify twice");
  assert.equal(container.querySelector("[data-contribution-receipt]"), null);

  pending = await begin();
  await act(async () => { pending.resolve({ status: "refused", message: "Signing cancelled." }); });
  assert.equal(container.querySelector("[data-contribution-receipt]"), null);
  assert.match(container.textContent!, /Signing cancelled/);
  pending = await begin();
  await act(async () => { pending.resolve({ status: "failed", message: "Transaction failed on chain.", digest: sent("m").digest }); });
  assert.equal(container.querySelector("[data-contribution-receipt]"), null);
  assert.match(container.textContent!, /Transaction failed on chain/);
  assert.equal(sonner.getToasts().length, before + 3);
  pending = await begin();
  await act(async () => root.unmount());
  await act(async () => { pending.resolve(sent("n")); });
  assert.equal(sonner.getToasts().length, before + 4, "confirmation survives the submitting host unmounting");
});


test("host quote failures preserve safe codes, response references and retry metadata", async (t) => {
  let response = Response.json({ error: { code: "rate_limited", message: "private database detail" } }, {
    status: 429, headers: { "X-Request-ID": "commit-quote-reference", "Retry-After": "17" },
  });
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL) => new URL(String(url), "https://blast.test").pathname.endsWith("/wallet") ? Response.json(wallet) : response.clone());
  const client = createTestQueryClient();
  client.setQueryData(queryKeys.me.wallet(), wallet);
  let host: CommitHostValue;
  function Host() {
    host = useCommitHost({ presaleDeployed: true, balances: { version: 0, changed() {} } });
    return null;
  }
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); client.clear(); });
  const router = { bfcacheId: "test", push() {}, replace() {}, prefetch() {}, back() {}, forward() {}, refresh() {}, hmrRefresh() {} };
  await act(async () => root.render(withQueryClient(client,
    <AppRouterContext value={router}><SocialAccountContext value={{ status: "signed_out", account: null, refresh() {} }}>
      <SocialViewerProvider signedIn callsign="kai" getAccessToken={async () => "test-access-token"}><ToastProvider><Host /></ToastProvider></SocialViewerProvider>
    </SocialAccountContext></AppRouterContext>)));
  const quotes = host!.overlays.commitKit!.quotes;
  await act(async () => { assert.equal(await quotes.fresh(ALON_ID), null); });
  const refused = quotes.peek(ALON_ID).error;
  assert.ok(refused instanceof QueryRefusal);
  assert.equal(refused.code, "rate_limited");
  assert.equal(refused.requestId, "commit-quote-reference");
  assert.equal(refused.httpStatus, 429);
  assert.equal(refused.retryAfterSeconds, 17);
  assert.match(refused.message, /Code: rate_limited\. Reference: commit-quote-reference\./);
  assert.doesNotMatch(refused.message, /private database detail/);

  response = Response.json({ private: "malformed success detail" }, { headers: { "X-Request-ID": "commit-invalid-reference" } });
  await act(async () => { assert.equal(await quotes.refresh(ALON_ID), null); });
  const invalid = quotes.peek(ALON_ID).error;
  assert.ok(invalid instanceof QueryTransientError);
  assert.equal(invalid.code, "invalid_response");
  assert.equal(invalid.httpStatus, 200);
  assert.equal(invalid.requestId, "commit-invalid-reference");
  assert.match(invalid.message, /Code: invalid_response\. Reference: commit-invalid-reference\./);
  assert.doesNotMatch(invalid.message, /malformed success detail/);
});

test("with no dialog open, passing time never redraws the host that wraps every screen", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: ALON_READ.presale.start_ms });
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
  const client = createTestQueryClient();
  let draws = 0;
  function Host() {
    draws++;
    const balances = useBalances(() => {});
    return useCommitHost({ presaleDeployed: true, balances }).node;
  }
  const root = createRoot(dom.document.createElement("div"));
  t.after(async () => { await act(async () => root.unmount()); client.clear(); });
  const router = { bfcacheId: "test", push() {}, replace() {}, prefetch() {}, back() {}, forward() {}, refresh() {}, hmrRefresh() {} };
  await act(async () => root.render(withQueryClient(client,
    <AppRouterContext value={router}><SocialAccountContext value={{ status: "signed_out", account: null, refresh() {} }}>
      <SocialViewerProvider signedIn={false} callsign={null} getAccessToken={undefined}><ToastProvider><Host /></ToastProvider></SocialViewerProvider>
    </SocialAccountContext></AppRouterContext>)));
  const settled = draws;
  for (let second = 0; second < 10; second++) await act(async () => { t.mock.timers.tick(1_000); });
  assert.equal(draws, settled);
});
