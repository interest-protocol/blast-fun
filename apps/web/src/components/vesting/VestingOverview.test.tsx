import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { QueryClient } from "@tanstack/react-query";
import { installTestDom, recordAnimations, setInputValue, testEvent } from "../../../test/fixtures/social/test-dom.ts";
import { HIDDEN_AMOUNT } from "@blast/core/lib/format.ts";

installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
const { QueryProvider } = await import("#web/lib/query/provider.tsx");
const { SocialViewerProvider } = await import("#web/components/social/SignInGate.tsx");
const { captureLists, useListRestoration } = await import("#web/components/blast-ui/list-restoration.ts");
const { installDisclosureMotion } = await import("#web/components/blast-ui/disclosure-motion.ts");
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "./use-vesting-wallet") return { url: "data:text/javascript,export function useVestingWallet() { return globalThis.vestingOverviewWallet; }", shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { VestingOverview } = await import("./VestingOverview");
hooks.deregister();
import { VestingReviewRequiredError } from "./execute-reviewed";
import type { PublicVesting } from "@blast/core/modules/vesting/model.ts";

const wallet = `0x${"a".repeat(64)}`;
const globals = globalThis as unknown as Record<string, unknown>;
globals.vestingOverviewWallet = { wallet: null, walletLoading: false, walletError: false, busy: false, node: null };
const schedule = (n: number, patch: Partial<PublicVesting> = {}): PublicVesting => ({
  schedule_id: `0x${String(n).repeat(64)}`, coin_type: "0x2::sui::SUI", beneficiary: wallet, creator: null,
  total: "1000000000", released: "0", refunded: "0", refund_recipient: null, cancel_cap_id: null,
  terms: { kind: "linear", action: "create", start_ms: "1", cliff_ms: "0", period_ms: "1000", periods: "10" } as PublicVesting["terms"],
  status: "active", created_timestamp_ms: null, created_digest: null, coin_name: "Sui", coin_symbol: "SUI", coin_decimals: 9, coin_icon_url: null, indexed: true, ...patch,
});

test("pending schedules use skeletons while public lookup remains available", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: 0, retry: false } } });
  const router = { bfcacheId: "test", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, prefetch: async () => {} };
  window.history.replaceState({}, "", "/portfolio/vestings");
  const render = () => renderToStaticMarkup(<AppRouterContext value={router}><QueryProvider client={client}><SocialViewerProvider signedIn callsign="loading-test"><VestingOverview embedded nowMs={5001} /></SocialViewerProvider></QueryProvider></AppRouterContext>);
  try {
    const pending = render();
    assert.match(pending, /aria-busy="true"/);
    assert.match(pending, /aria-label="Loading vesting schedules"/);
    assert.doesNotMatch(pending, /No vesting schedules/);
    assert.match(pending, /aria-label="Schedule ID"/);
    client.setQueryData(["blast", "me", "vesting"], { wallet, schedules: [schedule(1)] });
    const ready = render();
    assert.doesNotMatch(ready, /aria-label="Loading vesting schedules"/);
    assert.match(ready, /data-list-row=/);
  } finally { client.clear(); }
});

test("pending authentication shows skeletons until a settled session can show sign-in or schedules", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: 0, retry: false } } });
  const router = { bfcacheId: "test", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, prefetch: async () => {} };
  const render = (signedIn: boolean, sessionPending: boolean) => renderToStaticMarkup(<AppRouterContext value={router}><QueryProvider client={client}><SocialViewerProvider signedIn={signedIn} sessionPending={sessionPending}><VestingOverview nowMs={5001} /></SocialViewerProvider></QueryProvider></AppRouterContext>);
  try {
    for (const signedIn of [false, true]) {
      const pending = render(signedIn, true);
      assert.match(pending, /aria-label="Loading vesting schedules"/);
      assert.match(pending, /aria-busy="true"/);
      assert.doesNotMatch(pending, /Sign in|No vesting schedules/);
    }
    assert.match(render(false, false), /Sign in to see your vestings/);
    client.setQueryData(["blast", "me", "vesting"], { wallet, schedules: [] });
    const empty = render(true, false);
    assert.match(empty, /No incoming vesting schedules/);
    assert.doesNotMatch(empty, /Sign in|Loading vesting schedules/);
  } finally { client.clear(); }
});

test("the complete vesting list keeps receiving, creation, history and entry-specific filters distinct", async t => {
  const rows = [schedule(1), schedule(2, { creator: wallet, beneficiary: `0x${"b".repeat(64)}` }), schedule(3, { status: "closed" })];
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: 0, retry: false } } });
  client.setQueryData(["blast", "me", "vesting"], { wallet, schedules: rows });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); client.clear(); });
  const router = { bfcacheId: "test", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, prefetch: async () => {} };
  function Content() {
    const ref = useListRestoration("vesting-test", null, () => {});
    return <div ref={ref}><VestingOverview embedded nowMs={5001} allocationIds={[rows[0]!.schedule_id]} allocations={<div>Existing presale allocation</div>} /></div>;
  }
  window.history.replaceState({}, "", "/portfolio/vestings");
  await act(async () => root.render(<AppRouterContext value={router}><QueryProvider client={client}><SocialViewerProvider signedIn callsign="test"><Content /></SocialViewerProvider></QueryProvider></AppRouterContext>));
  assert.match(host.textContent!, /Existing presale allocation/);
  assert.equal(host.querySelectorAll("[data-list-row]").length, 0, "presale schedules are not repeated among public schedules");
  assert.doesNotMatch(host.textContent!, /No vesting schedules|View all/);
  const filter = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === name)!;
  await act(async () => filter("Created").click());
  assert.equal(host.querySelector("[data-list-row]")?.getAttribute("data-list-row"), rows[1]!.schedule_id);
  captureLists(); const created = structuredClone(window.history.state);
  await act(async () => filter("History").click());
  assert.equal(host.querySelector("[data-list-row]")?.getAttribute("data-list-row"), rows[2]!.schedule_id);
  captureLists(); const history = structuredClone(window.history.state);
  await act(async () => { window.history.replaceState(created, ""); window.dispatchEvent(new window.PopStateEvent("popstate")); });
  assert.equal(filter("Created").getAttribute("aria-pressed"), "true");
  await act(async () => { window.history.replaceState(history, ""); window.dispatchEvent(new window.PopStateEvent("popstate")); });
  assert.equal(filter("History").getAttribute("aria-pressed"), "true");
  assert.equal(host.querySelector('a[href="/vesting/new"]')?.textContent, "Create vesting");
});

test("public schedules mask totals and search the displayed ticker without metadata", async t => {
  const rows = Array.from({ length: 21 }, (_, index) => schedule(1, {
    schedule_id: `0x${(index + 1).toString(16).padStart(64, "0")}`,
    coin_type: index === 0 ? "0x2::coin::MOO" : "0x2::sui::SUI",
    coin_name: null,
    coin_symbol: null,
    total: "7654321000000000",
  }));
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: 0, retry: false } } });
  client.setQueryData(["blast", "me", "vesting"], { wallet, schedules: rows });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); client.clear(); });
  const router = { bfcacheId: "test", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, prefetch: async () => {} };
  const render = async (hidden: boolean) => {
    await act(async () => root.render(<AppRouterContext value={router}><QueryProvider client={client}><SocialViewerProvider signedIn callsign="mask-test"><VestingOverview embedded nowMs={5001} hidden={hidden} /></SocialViewerProvider></QueryProvider></AppRouterContext>));
  };
  window.history.replaceState({}, "", "/portfolio/vestings");
  await render(false);
  const amount = "7,654,321";
  assert.ok(host.innerHTML.includes(amount), "exact balance is available to inspection");
  const details = host.querySelector<HTMLDetailsElement>("[data-list-row] details")!;
  await act(async () => details.querySelector("summary")!.click());
  assert.equal(details.open, true);
  await render(true);
  assert.ok(!host.innerHTML.includes(amount), "hidden totals are absent from visible text and accessible attributes");
  assert.ok(host.textContent!.includes(`${HIDDEN_AMOUNT} MOO`));
  assert.equal(host.querySelectorAll("progress").length, 0, "privacy also masks numeric progress values");
  await act(async () => {
    const search = host.querySelector<HTMLInputElement>('input[aria-label="Search holdings"]')!;
    setInputValue(search, "MOO");
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  assert.equal(host.querySelectorAll("[data-list-row]").length, 1);
  assert.equal(host.querySelector("[data-list-row]")?.getAttribute("data-list-row"), rows[0]!.schedule_id);
  assert.doesNotMatch(host.textContent!, /No matching holdings/);
});

test("recipient inspection survives a refreshed row disappearing and returns focus to its filter", async t => {
  const motion = recordAnimations();
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: 0, retry: false } } });
  const current = schedule(1);
  client.setQueryData(["blast", "me", "vesting"], { wallet, schedules: [current] });
  const host = document.createElement("div");
  host.setAttribute("data-blast-ui", "");
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); client.clear(); });
  const router = { bfcacheId: "test", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, prefetch: async () => {} };
  window.history.replaceState({}, "", "/portfolio/vestings");
  await act(async () => root.render(<AppRouterContext value={router}><QueryProvider client={client}><SocialViewerProvider signedIn callsign="recipient-refresh-test"><VestingOverview embedded nowMs={5001} /></SocialViewerProvider></QueryProvider></AppRouterContext>));
  await act(async () => host.querySelector<HTMLElement>("[data-list-row] summary")!.click());
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Inspect recipient for Sui"]')!;
  trigger.focus();
  await act(async () => trigger.click());
  await act(async () => motion.finishAll());
  assert.equal(document.querySelector('[role="dialog"] code')?.textContent, wallet);
  await act(async () => {
    client.setQueryData(["blast", "me", "vesting"], { wallet, schedules: [{ ...current, status: "canceled" }] });
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  assert.equal(trigger.isConnected, false);
  assert.equal(document.querySelector('[role="dialog"] code')?.textContent, wallet, "ordinary query updates leave the inspected recipient readable");
  await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="Close"]')!.click());
  await act(async () => motion.finishAll());
  const receiving = host.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
  assert.equal(receiving?.textContent, "Receiving");
  assert.equal(document.activeElement, receiving, "a removed trigger falls back to the current filter");
  assert.equal(document.querySelector('[role="dialog"]'), null);
});

test("overview shows actual schedule amounts and timing without implying the viewer can claim", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: 0, retry: false } } });
  client.setQueryData(["blast", "me", "vesting"], { wallet, schedules: [schedule(1, { released: "100000000" })] });
  const router = { bfcacheId: "test", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, prefetch: async () => {} };
  window.history.replaceState({}, "", "/portfolio/vestings");
  try {
    const html = renderToStaticMarkup(<AppRouterContext value={router}><QueryProvider client={client}><SocialViewerProvider signedIn callsign="amounts-test"><VestingOverview embedded nowMs={5001} /></SocialViewerProvider></QueryProvider></AppRouterContext>);
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    assert.match(text, /Claimed 0.1 SUI Unclaimed 0.9 SUI Available to claim 0.4 SUI/);
    assert.match(text, /Allocated 1 SUI Unlocked 0.5 SUI/);
    assert.match(html, /<progress[^>]+aria-valuetext="50% unlocked"[^>]+value="50"/);
    assert.match(text, /Next unlock 1 Jan/);
    assert.match(html, /<time datetime="1970-01-01T00:00:06\.001Z"/i);
    assert.match(html, /title="View schedule"/);
    assert.doesNotMatch(html, /<details[^>]*open/);
    assert.match(html, /<button[^>]*disabled=""[^>]*aria-haspopup="dialog"[^>]*>.*?Claim vested coins/);
    assert.match(html, /aria-label="Inspect recipient for Sui"/);
  } finally { client.clear(); }
});

test("compact rows keep availability and timing outside their native secondary disclosure", async t => {
  const motion = recordAnimations();
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: 0, retry: false } } });
  client.setQueryData(["blast", "me", "vesting"], { wallet, schedules: [schedule(1, { released: "100000000" })] });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const cleanupMotion = installDisclosureMotion(document);
  t.after(async () => { cleanupMotion(); await act(async () => root.unmount()); host.remove(); client.clear(); });
  const router = { bfcacheId: "test", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, prefetch: async () => {} };
  window.history.replaceState({}, "", "/portfolio/vestings");
  await act(async () => root.render(<AppRouterContext value={router}><QueryProvider client={client}><SocialViewerProvider signedIn callsign="compact-details-test"><VestingOverview embedded nowMs={5001} /></SocialViewerProvider></QueryProvider></AppRouterContext>));
  const row = host.querySelector<HTMLElement>("[data-list-row]")!;
  const link = row.querySelector<HTMLAnchorElement>('a[title="View schedule"]')!;
  const details = row.querySelector<HTMLDetailsElement>("details")!;
  const summary = details.querySelector("summary")!;
  assert.equal(details.open, false);
  assert.equal(link.closest("details"), null);
  assert.match(link.textContent!, /Sui.*Next unlock/);
  const balances = row.querySelector('dl[aria-label="SUI vesting balances"]')!;
  assert.equal(balances.closest("details"), null);
  assert.match(balances.textContent!, /Claimed0.1SUIUnclaimed0.9SUIAvailable to claim0.4SUI/);
  assert.doesNotMatch(link.textContent!, /UTC/);
  assert.match(link.querySelector("time")!.title, /UTC/);
  assert.equal(link.getAttribute("aria-hidden"), null);
  assert.equal(link.getAttribute("href"), `/vesting/${schedule(1).schedule_id}`);
  assert.equal(link.querySelector("summary, button"), null, "navigation and disclosure have separate controls");
  const lookup = [...host.querySelectorAll<HTMLDetailsElement>("details")].find(item => item.querySelector("summary")?.textContent === "Open a public schedule by ID")!;
  assert.equal(lookup.open, false);

  await act(async () => summary.dispatchEvent(testEvent("click", { detail: 1 })));
  assert.equal(details.open, true);
  assert.equal(summary.getAttribute("aria-expanded"), "true");
  assert.match(details.textContent!, /Allocated1SUIUnlocked0.5SUI/);
  await act(async () => motion.finishAll());
  await act(async () => summary.dispatchEvent(testEvent("click", { detail: 1 })));
  assert.equal(summary.getAttribute("aria-expanded"), "false");
  assert.equal(details.querySelector("[inert]") !== null, true, "closing secondary controls stop receiving focus");
  await act(async () => motion.finishAll());
  assert.equal(details.open, false);
  const animationCount = motion.all.length;
  await act(async () => summary.click());
  assert.equal(details.open, true, "keyboard-style activation retains native disclosure behavior");
  assert.equal(motion.all.length, animationCount, "keyboard-style activation is immediate");
});

for (const recovery of ["pending", "unreachable"] as const) {
test(`direct claims recover rejection and ${recovery} execution without submitting twice`, async t => {
  const motion = recordAnimations();
  const current = schedule(1, { released: "100000000" });
  const attempt = { request_id: "claim-test", action: "claim", state: "submitted", digest: "8".repeat(44), transaction_bytes: "AA==", schedule_id: current.schedule_id, gas_budget: "5000000", expires_at_ms: Date.now() + 60_000 };
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ wallet, schedules: [current] }), { status: 200 }));
  const prepare = t.mock.fn(async () => attempt);
  let outcome: "rejected" | "pending" | "unreachable" = "rejected";
  const execute = t.mock.fn(async () => {
    if (outcome === "rejected") throw Object.assign(new Error("User rejected request"), { code: 4001 });
    if (outcome === "unreachable") throw new Error("Unable to confirm. Check the original transaction before retrying.");
    return attempt;
  });
  const refresh = t.mock.fn(async () => ({ ...attempt, state: "confirmed" }));
  globals.vestingOverviewWallet = { wallet, walletLoading: false, walletError: false, busy: false, prepare, execute, refresh, node: null };
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: 0, retry: false, enabled: false } } });
  client.setQueryData(["blast", "me", "vesting"], { wallet, schedules: [current] });
  const host = document.createElement("div"); host.setAttribute("data-blast-ui", ""); document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => { motion.finishAll(); root.unmount(); }); host.remove(); client.clear();
    globals.vestingOverviewWallet = { wallet: null, walletLoading: false, walletError: false, busy: false, node: null };
  });
  const router = { bfcacheId: "test", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, prefetch: async () => {} };
  window.history.replaceState({}, "", "/portfolio/vestings");
  await act(async () => root.render(<AppRouterContext value={router}><QueryProvider client={client}><SocialViewerProvider signedIn callsign="claim-test"><VestingOverview embedded nowMs={5001} /></SocialViewerProvider></QueryProvider></AppRouterContext>));
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label)!;
  const click = async (label: string) => act(async () => button(label).click());
  await click("Claim vested coins");
  assert.deepEqual(prepare.mock.calls[0]!.arguments, [{ action: "claim", scheduleId: current.schedule_id }]);
  assert.match(document.querySelector('[role="dialog"]')!.textContent!, /Available to beneficiary0.4SUI/);
  assert.match(document.querySelector('[role="dialog"]')!.textContent!, /Paid by your wallet/);
  assert.equal(execute.mock.callCount(), 0, "opening the review never signs");
  await click("Confirm in wallet");
  assert.match(document.querySelector('[role="alert"]')!.textContent!, /You rejected.*Nothing was sent/);
  assert.equal(host.querySelector('dl[aria-label="SUI vesting balances"]')!.textContent, "Claimed0.1SUIUnclaimed0.9SUIAvailable to claim0.4SUI");
  outcome = recovery;
  await click("Retry in wallet");
  assert.equal(execute.mock.callCount(), 2);
  assert.match(document.querySelector('[role="dialog"]')!.textContent!, /Check the original transaction/);
  await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="Close"]')!.click());
  await act(async () => motion.finishAll());
  await click("Check claim status");
  assert.equal(prepare.mock.callCount(), 1, "reopening a pending claim preserves the reviewed transaction");
  await click("Check transaction status");
  assert.equal(execute.mock.callCount(), 2, "status checking never signs again");
  assert.equal(refresh.mock.callCount(), 1);
  await act(async () => motion.finishAll());
  assert.ok(button("Updating balances").disabled);
  assert.equal(document.activeElement?.textContent, "Receiving", "confirmed claims restore focus to the current filter when Claim is disabled");
  assert.match(host.textContent!, /Claimed0.1SUIUnclaimed0.9SUIAvailable to claim0.4SUI/);
  await act(async () => {
    client.setQueryData(["blast", "me", "vesting"], { wallet, schedules: [{ ...current, released: "500000000" }] });
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  assert.match(host.textContent!, /Claimed0.5SUIUnclaimed0.5SUIAvailable to claim0SUI/);
  assert.ok(button("Nothing to claim yet").disabled);
});

}

for (const message of ["This review expired. Review the current schedule again.", "The gas payer changed. Review this schedule again with your current wallet."]) {
  test(`safe preparation retry: ${message}`, async t => {
    const motion = recordAnimations();
    const current = schedule(1);
    const attempt = { request_id: "safe-retry", state: "submitted", digest: "8".repeat(44), gas_budget: "5000000" };
    const prepare = t.mock.fn(async () => attempt);
    const execute = t.mock.fn(async () => { throw new VestingReviewRequiredError(message); });
    globals.vestingOverviewWallet = { wallet, walletLoading: false, walletError: false, busy: false, prepare, execute, node: null };
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: 0, retry: false } } });
    client.setQueryData(["blast", "me", "vesting"], { wallet, schedules: [current] });
    const host = document.createElement("div"); host.setAttribute("data-blast-ui", ""); document.body.append(host);
    const root = createRoot(host);
    t.after(async () => {
      await act(async () => { motion.finishAll(); root.unmount(); }); host.remove(); client.clear();
      globals.vestingOverviewWallet = { wallet: null, walletLoading: false, walletError: false, busy: false, node: null };
    });
    const router = { bfcacheId: "test", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, prefetch: async () => {} };
    window.history.replaceState({}, "", "/portfolio/vestings");
    await act(async () => root.render(<AppRouterContext value={router}><QueryProvider client={client}><SocialViewerProvider signedIn callsign="safe-retry"><VestingOverview embedded nowMs={5001} /></SocialViewerProvider></QueryProvider></AppRouterContext>));
    const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label)!;
    await act(async () => button("Claim vested coins").click());
    await act(async () => button("Confirm in wallet").click());
    assert.equal(document.querySelector('[role="alert"]')?.textContent, message);
    assert.equal(button("Check transaction status"), undefined);
    await act(async () => button("Retry").click());
    assert.equal(prepare.mock.callCount(), 2);
    assert.equal(execute.mock.callCount(), 1, "a new review never executes without a fresh confirmation");
    assert.ok(button("Confirm in wallet"));
  });
}

test("unpriced AFTEST receipts keep exact availability and locked timing without counting created membership twice", async t => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: 0, retry: false } } });
  const start = String(Date.parse("2026-11-16T00:00:00Z"));
  const aftest = { coin_type: "0x2::aftest::AFTEST", coin_name: "AFTEST", coin_symbol: "AFTEST" };
  const receiving = schedule(1, { ...aftest, creator: wallet, total: "81297878320681999" });
  const locked = schedule(2, { ...aftest, total: "124968397112711982",
    terms: { kind: "linear", action: "create", start_ms: start, cliff_ms: "0", period_ms: "1000", periods: "10" } as PublicVesting["terms"] });
  const created = schedule(3, { ...aftest, creator: wallet, beneficiary: `0x${"b".repeat(64)}` });
  client.setQueryData(["blast", "me", "vesting"], { wallet, schedules: [receiving, locked, created] });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); client.clear(); });
  const router = { bfcacheId: "test", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, prefetch: async () => {} };
  window.history.replaceState({}, "", "/portfolio/vestings");
  await act(async () => root.render(<AppRouterContext value={router}><QueryProvider client={client}><SocialViewerProvider signedIn callsign="aftest-visibility"><VestingOverview nowMs={Date.parse("2026-10-26T00:00:00Z")} /></SocialViewerProvider></QueryProvider></AppRouterContext>));
  assert.equal(host.querySelectorAll("[data-list-row]").length, 2);
  const available = host.querySelector(`[data-list-row="${receiving.schedule_id}"]`)!;
  assert.ok(available.querySelector('[aria-label="Inspect full available AFTEST: 81,297,878.320681999 AFTEST"]'));
  assert.match(available.textContent!, /Claim vested coins/);
  assert.equal(available.querySelector('a[title="View schedule"]')?.getAttribute("href"), `/vesting/${receiving.schedule_id}`);
  const waiting = host.querySelector(`[data-list-row="${locked.schedule_id}"]`)!;
  assert.match(waiting.textContent!, /First unlock 16 Nov/);
  assert.match(waiting.querySelector("time")?.dateTime ?? "", /^2026-11-16T/);
  assert.ok(waiting.querySelector('[aria-label="Inspect full remaining AFTEST: 124,968,397.112711982 AFTEST"]'));
  assert.match(waiting.textContent!, /Available to claim0AFTEST/);
  assert.doesNotMatch(host.textContent!, /\$0|Nothing claimable/);
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Created")!.click());
  assert.equal(host.querySelectorAll("[data-list-row]").length, 2);
  const createdOnly = host.querySelector(`[data-list-row="${created.schedule_id}"]`)!;
  assert.equal(createdOnly.querySelector('[aria-haspopup="dialog"]:disabled'), null, "creator visibility never grants the recipient's claim action");
  assert.doesNotMatch(createdOnly.textContent!, /Claim vested coins|Nothing to claim yet/);
});

test("a failed schedule read leaves loading for an actionable error rather than empty or sign-in guidance", async t => {
  const { settleQueries } = await import("#web/lib/query/test-client.ts");
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: 0, retry: false } } });
  const originalFetch = globalThis.fetch;
  let finish!: (response: Response) => void;
  const response = new Promise<Response>(resolve => { finish = resolve; });
  globalThis.fetch = async () => (await response).clone();
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); client.clear(); globalThis.fetch = originalFetch; });
  const router = { bfcacheId: "test", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, prefetch: async () => {} };
  window.history.replaceState({}, "", "/portfolio/vestings");
  await act(async () => root.render(<AppRouterContext value={router}><QueryProvider client={client}><SocialViewerProvider signedIn callsign="failed-vesting-read"><VestingOverview nowMs={5001} /></SocialViewerProvider></QueryProvider></AppRouterContext>));
  assert.ok(host.querySelector('[aria-label="Loading vesting schedules"]'));
  await act(async () => {
    finish(Response.json({ error: { code: "service_unavailable", reasons: ["vesting_index_unavailable"] } }, { status: 503 }));
    await settleQueries(client);
  });
  assert.match(host.querySelector('[role="alert"]')?.textContent ?? "", /Vesting history is not indexed yet/);
  assert.equal([...host.querySelectorAll("button")].some(button => button.textContent === "Retry"), false, "an indexing gap cannot recover through repeated wallet reads");
  assert.doesNotMatch(host.textContent!, /Sign in|No vesting schedules/);
  assert.equal(host.querySelector('[aria-label="Loading vesting schedules"]'), null);
});
