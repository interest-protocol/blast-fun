import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { registerHooks } from "node:module";
import { SUI_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { installTestDom, setInputValue, testEvent } from "../../../../test/fixtures/social/test-dom.ts";
import { createTransactionProvider } from "../../../../test/fixtures/workspace/transactions/provider.ts";

const dom = installTestDom();
dom.window.reducedMotion = true;
Object.assign(dom.document, { oninput: null });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
const { SocialViewerProvider } = await import("../SignInGate");
const { ToastProvider } = await import("#web/components/blast-ui/Toasts.tsx");
const { createTestQueryClient, withQueryClient } = await import("#web/lib/query/test-client.ts");
// Stub the mounted Privy boundary, so the real host still receives its signer through the bridge.
const reactUrl = import.meta.resolve("react");
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith("/commit/CommitHost.tsx")) {
      if (specifier.endsWith("/PrivySessionProvider.tsx")) return { shortCircuit: true, url: "data:text/javascript,export const usePrivySessionMounted=()=>true" };
      if (specifier === "../coins/signers") return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`
        import {useEffect} from ${JSON.stringify(reactUrl)};
        export function PrivyCoinSignerBridge({onChange}) {
          useEffect(()=>{onChange({signer:()=>globalThis.commitPendingSignerFixture()});return()=>onChange(null)},[onChange]);
          return null;
        }
      `)}` };
    }
    return nextResolve(specifier, context);
  },
});
const { useCommitHost } = await import("./CommitHost");
const { InlineCommit } = await import("./InlineCommit");
// Record the public build request while the real host, panel and transaction flow run.
function recordBuilds(t: TestContext, provider: ReturnType<typeof createTransactionProvider>) {
  const builds: unknown[] = [];
  t.mock.method(globalThis, "fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/api/social/me/commits")) {
      builds.push(JSON.parse(String(init?.body)));
    }
    return provider.fetch(input, init);
  });
  return builds;
}

// One stable token source: a new function on each render would make the host build a new quote source.
const ownerToken = async () => "original-owner";
const router = { bfcacheId: "test", push() {}, replace() {}, prefetch() {}, back() {}, forward() {}, refresh() {}, hmrRefresh() {} };

async function waitFor(check: () => unknown, label: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
  }
  assert.fail(label);
}

test("R3-41-AC-7: a dialog sends exact USDC atoms once, retains an unknown outcome, and requires a new press to contribute again", async (t) => {
  const provider = createTransactionProvider();
  Object.assign(globalThis, { commitPendingSignerFixture: provider.signer });
  t.after(() => Reflect.deleteProperty(globalThis, "commitPendingSignerFixture"));
  provider.setMode("unknown");
  const builds = recordBuilds(t, provider);
  const client = createTestQueryClient();
  const container = dom.document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  dom.document.body.append(container);
  const root = createRoot(container);
  function Host() {
    const host = useCommitHost({ presaleDeployed: true, balances: { version: 0, changed: provider.moved } });
    return <><button onClick={() => host.overlays.openCommitTo?.(provider.detail.presale.presale_id, null)}>Open commit</button>{host.node}</>;
  }
  const render = () => root.render(withQueryClient(client, <AppRouterContext value={router}>
    <SocialViewerProvider signedIn callsign="original" getAccessToken={ownerToken}><ToastProvider><Host /></ToastProvider></SocialViewerProvider>
  </AppRouterContext>));
  t.after(async () => { provider.finish(); await act(async () => root.unmount()); client.clear(); container.remove(); });
  await act(render);
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  await waitFor(() => container.querySelector('input[inputmode="decimal"]'), "dialog loaded");
  const typeAmount = async (value: string) => act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
    setInputValue(input, value);
    input.dispatchEvent(testEvent("input"));
  });
  const submit = () => container.querySelector<HTMLButtonElement>('[data-kind="commit"] [data-ui-variant="primary"]')!;
  await typeAmount("12.345678");
  await waitFor(() => submit() && !submit().disabled, "dialog ready");
  await act(async () => submit().click());
  await waitFor(() => provider.counts.executes === 1, "one execution");
  assert.deepEqual(builds, [{
    presale_id: provider.detail.presale.presale_id,
    pay_with: "QUOTE",
    amount: "12345678",
  }]);
  await act(async () => submit().click());
  assert.equal(provider.counts.signs, 1, "another press during execution cannot sign again");
  assert.equal(provider.counts.builds, 1, "another press during execution cannot build again");
  await act(async () => provider.finish());
  await waitFor(() => provider.counts.moved === 1, "pending outcome returned");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 2700)); render(); });
  const pending = container.querySelector('[data-commit-pending]');
  assert.ok(pending, "the still-open form keeps the recovery information");
  assert.match(pending.textContent!, /could not confirm.*Check .* on Sui before blasting again/);
  assert.match(pending.textContent!, new RegExp(provider.intents[0]!.digest));
  assert.equal(container.querySelector('[data-kind="commit"] [role="alert"]'), null);
  assert.equal(container.querySelector("[data-contribution-receipt]"), null);
  assert.equal(provider.counts.executes, 1, "time and rerender never submit");
  assert.equal(submit().disabled, false, "pending information does not permanently lock explicit actions");

  provider.setMode("confirmed");
  await typeAmount("50");
  await act(async () => submit().click());
  await waitFor(() => provider.counts.executes === 2, "a later explicit contribution executes");
  await act(async () => provider.finish());
  await waitFor(() => container.querySelector("[data-contribution-receipt]"), "only confirmed execution shows a receipt");
  assert.equal(provider.counts.executes, 2);
  assert.deepEqual(builds[1], {
    presale_id: provider.detail.presale.presale_id,
    pay_with: "QUOTE",
    amount: "50000000",
  });
  assert.match(container.querySelector("[data-contribution-receipt]")!.textContent!, /50 USDC/);
});

test("R3-41-AC-7 and OA-43: an inline SUI contribution sends nine-decimal atoms once and keeps an unknown outcome separate from cancellation", async (t) => {
  const provider = createTransactionProvider();
  Object.assign(provider.detail.presale, {
    quote_symbol: "SUI",
    quote_type: SUI_COIN_TYPE,
    quote_decimals: 9,
    min_commitment_atoms: "1000000000",
    wallet_cap_atoms: "5000000000000",
    target_atoms: "10000000000000",
    raised_atoms: "123450000000",
  });
  Object.assign(globalThis, { commitPendingSignerFixture: provider.signer });
  t.after(() => Reflect.deleteProperty(globalThis, "commitPendingSignerFixture"));
  provider.setMode("unknown");
  const builds = recordBuilds(t, provider);
  const client = createTestQueryClient();
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  let committed = 0;
  let confirmed = 0;
  function Host() {
    const host = useCommitHost({ presaleDeployed: true, balances: { version: 0, changed: provider.moved } });
    return <><InlineCommit kit={host.overlays.commitKit!} presaleId={provider.detail.presale.presale_id} fallback={null} onCommitted={() => { committed++; }} purchase={{ initialPayCoin: SUI_COIN_TYPE, onConfirmed: () => { confirmed++; } }} />{host.node}</>;
  }
  const render = () => root.render(withQueryClient(client, <AppRouterContext value={router}>
    <SocialViewerProvider signedIn callsign="original" getAccessToken={ownerToken}><ToastProvider><Host /></ToastProvider></SocialViewerProvider>
  </AppRouterContext>));
  t.after(async () => { provider.finish(); await act(async () => root.unmount()); client.clear(); container.remove(); });
  await act(render);
  const submit = () => container.querySelector<HTMLButtonElement>('[data-inline-commit] [data-ui-variant="primary"]')!;
  await waitFor(() => container.querySelector('input[inputmode="decimal"]'), "inline loaded");
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
    setInputValue(input, "12.345678901");
    input.dispatchEvent(testEvent("input"));
  });
  await waitFor(() => submit() && !submit().disabled, "inline ready");
  const amount = container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
  await act(async () => submit().click());
  await waitFor(() => provider.counts.executes === 1, "one execution");
  assert.deepEqual(builds, [{
    presale_id: provider.detail.presale.presale_id,
    pay_with: "QUOTE",
    amount: "12345678901",
  }]);
  await act(async () => submit().click());
  assert.equal(provider.counts.signs, 1);
  assert.equal(provider.counts.builds, 1);
  await act(async () => provider.finish());
  await waitFor(() => provider.counts.moved === 1, "pending outcome returned");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 2700)); render(); });
  const pending = container.querySelector('[data-inline-commit] [data-commit-pending]');
  assert.ok(pending, "inline keeps pending separate from refusal " + container.textContent);
  assert.match(pending.textContent!, new RegExp(provider.intents[0]!.digest));
  assert.ok(pending.querySelector("a")?.href.endsWith(provider.intents[0]!.digest));
  assert.equal(container.querySelector('[data-inline-commit] [role="alert"]'), null);
  assert.equal(container.querySelector('input[inputmode="decimal"]'), amount, "pending does not reset the form");
  assert.equal(provider.counts.executes, 1);
  assert.equal(committed, 0);
  assert.equal(confirmed, 0);
  assert.equal(submit().disabled, false);

  provider.setMode("cancelled");
  await act(async () => submit().click());
  await waitFor(() => container.querySelector('[data-inline-commit] [role="alert"]'), "explicit later cancellation is a refusal");
  assert.equal(container.querySelector('[data-inline-commit] [data-commit-pending]'), null);
  assert.match(container.querySelector('[data-inline-commit] [role="alert"]')!.textContent!, /cancel|confirm|reject/i);
  assert.equal(provider.counts.signs, 2);
  assert.deepEqual(builds[1], {
    presale_id: provider.detail.presale.presale_id,
    pay_with: "QUOTE",
    amount: "12345678901",
  });
  assert.equal(provider.counts.executes, 1, "cancelled signature never executes");
  assert.equal(committed, 0);
  assert.equal(confirmed, 0);
});
