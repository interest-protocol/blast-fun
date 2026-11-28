import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { type TestContext } from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { installTestDom } from "../../../test/fixtures/social/test-dom.ts";
import type { VestingDetail as Detail } from "@blast/core/modules/vesting/model.ts";

const { document, window } = installTestDom();
// The page reads its wallet once per draw of its whole view: the stub counts those draws.
const globals = globalThis as unknown as { vestingTestWallet: unknown; vestingViewDraws: number };
globals.vestingViewDraws = 0;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./use-vesting-wallet") {
      return {
        url: `data:text/javascript,${encodeURIComponent("export function useVestingWallet() { globalThis.vestingViewDraws += 1; return globalThis.vestingTestWallet; }")}`,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
const { VestingDetail } = await import("./VestingDetail");
hooks.deregister();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryProvider } = await import("#web/lib/query/provider.tsx");

const NOW = 1_792_276_800_000;
const SECOND = 1_000;
const beneficiary = `0x${"a".repeat(64)}`;

function schedule(terms: Detail["schedule"]["terms"], total: string): Detail["schedule"] {
  return {
    schedule_id: `0x${"b".repeat(64)}`,
    coin_type: "0x2::coin::TOKEN",
    beneficiary,
    creator: beneficiary,
    total,
    released: "0",
    refunded: "0",
    refund_recipient: null,
    cancel_cap_id: null,
    terms,
    status: "active",
    created_timestamp_ms: null,
    created_digest: null,
    coin_name: "Test",
    coin_symbol: "TOKEN",
    coin_decimals: 0,
    coin_icon_url: null,
    indexed: true,
  };
}

async function mount(t: TestContext, detail: Detail["schedule"]) {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: NOW });
  t.mock.method(window.HTMLCanvasElement.prototype, "getContext", () => null);
  // A refresh that never answers: the clock alone moves the page.
  t.mock.method(globalThis, "fetch", () => new Promise<never>(() => {}));
  globals.vestingTestWallet = {
    wallet: beneficiary,
    viewer: { signedIn: true, sessionPending: false },
    busy: false,
    phase: "idle",
    node: null,
    walletLoading: false,
    walletError: false,
    retryWallet: async () => {},
    prepare: async () => null,
  };
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: 0, retry: false } } });
  client.setQueryData(["blast", "me", "vesting-eligibility", detail.schedule_id, beneficiary, null], false);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
  });
  await act(async () => root.render(
    <QueryProvider client={client}>
      <VestingDetail initial={{ now_ms: NOW, schedule: detail, events: [] }} />
    </QueryProvider>,
  ));
  const claimable = () => [...host.querySelectorAll("h3")].find((heading) => heading.textContent === "Available to claim")?.nextElementSibling?.textContent ?? "";
  const pass = (ms: number) => act(async () => { t.mock.timers.tick(ms); });
  return { claimable, pass, mounted: globals.vestingViewDraws };
}

test("a continuous schedule's claimable amount moves each second without redrawing the page", async (t) => {
  // 7,200 tokens over two hours, one a second, an hour in.
  const page = await mount(t, schedule({ kind: "linear", start_ms: String(NOW - 3_600 * SECOND), period_ms: "1", periods: String(7_200 * SECOND), cliff_ms: "0" }, "7200"));
  assert.equal(page.claimable(), "3,600TOKEN");
  const shown: string[] = [];
  for (let second = 1; second <= 10; second++) {
    await page.pass(SECOND);
    shown.push(page.claimable());
  }
  assert.deepEqual(shown, [3_601, 3_602, 3_603, 3_604, 3_605, 3_606, 3_607, 3_608, 3_609, 3_610].map((amount) => `${amount.toLocaleString("en-US")}TOKEN`));
  t.diagnostic(`VestingDetail view renders in 10 s (continuous): ${globals.vestingViewDraws - page.mounted}`);
  assert.equal(globals.vestingViewDraws - page.mounted, 0, "only the money moves each second");
});

test("a stepped schedule's claimable amount changes at its release, the only redraw in ten seconds", async (t) => {
  // 60 tokens in six releases ten seconds apart; two are out, the next is five seconds away.
  const page = await mount(t, schedule({ kind: "linear", start_ms: String(NOW - 25 * SECOND), period_ms: String(10 * SECOND), periods: "6", cliff_ms: "0" }, "60"));
  assert.equal(page.claimable(), "20TOKEN");
  await page.pass(5 * SECOND - 1);
  assert.equal(page.claimable(), "20TOKEN");
  await page.pass(1);
  assert.equal(page.claimable(), "30TOKEN", "the release shows the moment it unlocks");
  await page.pass(5 * SECOND);
  t.diagnostic(`VestingDetail view renders in 10 s (stepped): ${globals.vestingViewDraws - page.mounted}`);
  assert.equal(globals.vestingViewDraws - page.mounted, 1);
});
