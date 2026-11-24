import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { type TestContext } from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { installTestDom, waitFor } from "../../../test/fixtures/social/test-dom.ts";
import type { VestingDetail as Detail } from "@blast/core/modules/vesting/model.ts";

installTestDom();
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./use-vesting-wallet") {
      return {
        url: "data:text/javascript,export function useVestingWallet() { return globalThis.vestingTestWallet; }",
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

for (const [action, buttonLabel, statusLabel] of [
  ["claim", "Claim vested coins", "Preparing claim"],
  ["cancel", "Cancel vesting", "Preparing cancellation"],
  ["close", "Close empty schedule", "Preparing schedule closure"],
] as const) {
  test(`${action} preparation stays on its own button and resets after failure`, async (t) => {
    const wallet = `0x${"a".repeat(64)}`;
    const schedule: Detail["schedule"] = {
      schedule_id: `0x${"b".repeat(64)}`,
      coin_type: "0x2::sui::SUI",
      beneficiary: wallet,
      creator: wallet,
      total: "1000000000",
      released: action === "close" ? "1000000000" : "0",
      refunded: "0",
      refund_recipient: action === "cancel" ? wallet : null,
      cancel_cap_id: null,
      terms:
        action === "claim"
          ? {
              kind: "checkpoints",
              checkpoints: [
                { timestamp_ms: "1", cumulative_amount: "1000000000" },
              ],
            }
          : { kind: "checkpoints", checkpoints: null, checkpoint_count: "1" },
      status: "active",
      created_timestamp_ms: null,
      created_digest: null,
      coin_name: "Sui",
      coin_symbol: "SUI",
      coin_decimals: 9,
      coin_icon_url: null,
      indexed: true,
    };
    const pending = Promise.withResolvers<never>();
    const prepare = t.mock.fn((intent: { action: string }) => {
      assert.equal(intent.action, action);
      return pending.promise;
    });
    const globals = globalThis as unknown as Record<string, unknown>;
    globals.vestingTestWallet = {
      wallet,
      viewer: { signedIn: true },
      busy: false,
      phase: "idle",
      prepare,
      node: null,
    };
    const client = new QueryClient({
      defaultOptions: {
        queries: { staleTime: Infinity, gcTime: 0, retry: false },
      },
    });
    client.setQueryData(
      ["blast", "me", "vesting-eligibility", schedule.schedule_id, wallet, null],
      action === "cancel",
    );
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    t.after(async () => {
      await act(async () => root.unmount());
      host.remove();
      client.clear();
      delete globals.vestingTestWallet;
    });
    await act(async () =>
      root.render(
        <QueryProvider client={client}>
          <VestingDetail
            initial={{ now_ms: Date.now(), schedule, events: [] }}
          />
        </QueryProvider>,
      ),
    );
    const button = [...host.querySelectorAll("button")].find(
      (item) => item.textContent === buttonLabel,
    )!;
    assert.ok(button && !button.disabled);
    await act(async () => button.click());
    assert.equal(prepare.mock.calls[0]?.arguments[0]?.action, action);
    assert.equal(
      button.querySelector('[role="status"]')?.getAttribute("aria-label"),
      statusLabel,
    );
    assert.equal(host.querySelectorAll('button [role="status"]').length, 1);
    assert.ok(
      [...host.querySelectorAll("button")]
        .filter((item) =>
          /Claim vested coins|Cancel vesting|Close empty schedule/.test(
            item.textContent ?? "",
          ),
        )
        .every((item) => item.disabled),
    );
    await act(async () =>
      pending.reject(new Error("Preparation unavailable. Retry.")),
    );
    assert.equal(host.querySelector('button [role="status"]'), null);
    assert.equal(button.disabled, false);
    assert.match(
      host.querySelector('[role="alert"]')?.textContent ?? "",
      /Preparation unavailable/,
    );
  });
}

const beneficiary = `0x${"a".repeat(64)}`;
const otherWallet = `0x${"c".repeat(64)}`;
const baseSchedule: Detail["schedule"] = {
  schedule_id: `0x${"b".repeat(64)}`,
  coin_type: "0x2::coin::TOKEN",
  beneficiary,
  creator: otherWallet,
  total: "124968397112711982",
  released: "0",
  refunded: "0",
  refund_recipient: otherWallet,
  cancel_cap_id: null,
  terms: {
    kind: "linear",
    start_ms: "1792276800000",
    period_ms: "2592000000",
    periods: "12",
    cliff_ms: "0",
  },
  status: "active",
  created_timestamp_ms: null,
  created_digest: null,
  coin_name: "Test",
  coin_symbol: "TOKEN",
  coin_decimals: 9,
  coin_icon_url: null,
  indexed: true,
};

async function mountDetail(
  t: TestContext,
  options: {
    schedule?: Detail["schedule"];
    now?: number;
    wallet?: string | null;
    loading?: boolean;
    sessionPending?: boolean;
    signedIn?: boolean;
    walletError?: boolean;
    authority?: boolean;
    execute?: () => Promise<unknown>;
    refresh?: () => Promise<unknown>;
  } = {},
) {
  t.mock.method(window.HTMLCanvasElement.prototype, "getContext", () => null);
  // The detail's clock ticks to Date.now() after a second; pin it to the fixture's time so a slow run
  // does not read the real date (before the first release, nothing is claimable).
  const nowMs = options.now ?? 1792276800000 - 1;
  t.mock.method(Date, "now", () => nowMs);
  const schedule = options.schedule ?? baseSchedule;
  const address = options.wallet === undefined ? beneficiary : options.wallet;
  const attempt = {
    action: "claim",
    request_id: "fixture",
    state: "submitted",
    digest: "fixture",
    gas_budget: "1",
    transaction_bytes: "not-signable",
    expires_at_ms: Date.now() + 60000,
  };
  (globalThis as unknown as Record<string, unknown>).vestingTestWallet = {
    wallet: address,
    viewer: { signedIn: options.signedIn ?? !!address, sessionPending: options.sessionPending ?? false },
    busy: false,
    phase: "idle",
    node: null,
    walletLoading: !!options.loading,
    walletError: !!options.walletError,
    retryWallet: async () => {},
    prepare: async () => attempt,
    execute: options.execute ?? (async () => attempt),
    refresh: options.refresh ?? (async () => attempt),
  };
  const client = new QueryClient({
    defaultOptions: {
      queries: { staleTime: Infinity, gcTime: 0, retry: false },
    },
  });
  client.setQueryData(
    ["blast", "me", "vesting-eligibility", schedule.schedule_id, address, null],
    !!options.authority,
  );
  const host = document.createElement("div");
  host.setAttribute("data-blast-ui", "");
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
  });
  const render = (currentSchedule = schedule) =>
    root.render(
      <QueryProvider client={client}>
        <VestingDetail
          initial={{
            now_ms: nowMs,
            schedule: currentSchedule,
            events: [],
          }}
        />
      </QueryProvider>,
    );
  await act(async () => render());
  return { host, client, render };
}

async function openContractDetails(host: HTMLElement) {
  const trigger = [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.startsWith("Contract details"),
  )!;
  await act(async () => trigger.click());
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
}

for (const [name, options, reason] of [
  [
    "future release",
    { wallet: null },
    /Nothing to claim yet\. First release: 16 Nov ’26/,
  ],
  [
    "wrong wallet",
    { now: 1794868800000, wallet: otherWallet },
    /To claim through Blast, use the beneficiary/,
  ],
  [
    "wallet loading",
    { now: 1794868800000, loading: true },
    /Checking your Blast wallet/,
  ],
  [
    "wallet error",
    { now: 1794868800000, walletError: true },
    /wallet could not be loaded/,
  ],
  [
    "missing terms",
    {
      schedule: {
        ...baseSchedule,
        terms: {
          kind: "checkpoints" as const,
          checkpoints: null,
          checkpoint_count: "3",
        },
      },
    },
    /release data is unavailable/,
  ],
  [
    "canceled",
    { schedule: { ...baseSchedule, status: "canceled" as const } },
    /schedule is canceled/,
  ],
  [
    "closed",
    { schedule: { ...baseSchedule, status: "closed" as const } },
    /schedule is closed/,
  ],
  [
    "fully claimed",
    {
      now: 1830000000000,
      schedule: { ...baseSchedule, released: baseSchedule.total },
    },
    /All funds have been claimed/,
  ],
] as const) {
  test(`${name}: disabled claim has an adjacent accurate explanation`, async (t) => {
    const { host } = await mountDetail(t, options);
    const button = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Claim vested coins",
    )!;
    assert.ok(button.disabled);
    assert.equal(
      button.getAttribute("aria-describedby"),
      "vesting-claim-explanation",
    );
    assert.match(
      host.querySelector("#vesting-claim-explanation")!.textContent!,
      reason,
    );
    assert.equal(host.querySelectorAll("h3").length > 0, true);
  });
}

test("refund recipient is separate and cannot cancel without verified key ownership", async (t) => {
  const { host } = await mountDetail(t, { wallet: otherWallet });
  assert.ok(
    host.querySelector(
      `[aria-label="Inspect full beneficiary address: ${beneficiary}"]`,
    ),
  );
  await openContractDetails(host);
  assert.ok(
    host.querySelector(
      `[aria-label="Inspect full refund recipient address: ${otherWallet}"]`,
    ),
  );
  assert.doesNotMatch(
    host.textContent!,
    /Your wallet holds the cancellation key/,
  );
  const cancel = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Cancel vesting",
  );
  assert.equal(cancel, undefined);
  assert.match(host.textContent!, /This wallet cannot cancel this vesting\./);
  assert.doesNotMatch(host.textContent!, /cancellation key required/);
});

test("stale schedule blocks a claim and exposes recovery", async (t) => {
  const { host, client } = await mountDetail(t, { now: 1794868800000 });
  await act(async () => {
    client
      .getQueryCache()
      .find({ queryKey: ["vesting", baseSchedule.schedule_id] })!
      .setState({ status: "error", error: new Error("read unavailable") });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.match(
    host.querySelector("#vesting-claim-explanation")!.textContent!,
    /Unable to refresh/,
  );
  const buttons = [...host.querySelectorAll("button")];
  assert.ok(
    buttons.find((button) => button.textContent === "Claim vested coins")!
      .disabled,
  );
  assert.ok(buttons.some((button) => button.textContent === "Retry schedule"));
});

test("claim balances shorten decimals while inspection and review retain the exact payout", async (t) => {
  const total = "123456123456789";
  const { host } = await mountDetail(t, {
    schedule: {
      ...baseSchedule,
      total,
      terms: {
        kind: "checkpoints",
        checkpoints: [{ timestamp_ms: "1", cumulative_amount: total }],
      },
    },
  });
  const inspect = host.querySelector(
    '[aria-label="Inspect full claimable amount: 123,456.123456789 TOKEN"]',
  )!;
  assert.match(inspect.textContent!, /≈ 123,456\.12/);
  assert.doesNotMatch(inspect.textContent!, /123456789/);
  assert.equal(host.querySelector("details, summary"), null);
  const claim = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Claim vested coins",
  )!;
  await act(async () => claim.click());
  const review = document.querySelector('[role="dialog"]')!;
  assert.match(review.textContent!, /123,456\.123456789/);
  assert.doesNotMatch(review.textContent!, /≈/);
});

test("the primary balance and irrevocable policy are visible without opening metadata", async (t) => {
  const { host } = await mountDetail(t, {
    now: 1794868800000,
    schedule: { ...baseSchedule, refund_recipient: null },
  });
  const amount = host.querySelector(
    '[aria-label^="Inspect full claimable amount:"]',
  )!;
  assert.match(amount.textContent!, /≈ 10,414,033\.09/);
  assert.doesNotMatch(amount.textContent!, /10\.41M/);
  assert.match(
    host.textContent!,
    /Irrevocable · this schedule cannot be canceled/,
  );
  assert.equal(
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "Contract details")
      ?.getAttribute("aria-expanded"),
    "false",
  );
  assert.equal(host.querySelector('button[aria-label*="timestamp"]'), null);
});

test("cancellation authority loading, unknown, failure and denial stay distinct", async (t) => {
  const { host, client } = await mountDetail(t);
  const query = client.getQueryCache().find({
    queryKey: [
      "blast",
      "me",
      "vesting-eligibility",
      baseSchedule.schedule_id,
      beneficiary,
      null,
    ],
  })!;
  const update = async (state: Parameters<typeof query.setState>[0]) => {
    await act(async () => {
      query.setState(state);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const message = () =>
    host.querySelector("#vesting-cancel-explanation")!.textContent!;
  assert.equal(message(), "This wallet cannot cancel this vesting.");
  await update({ data: undefined, status: "pending", fetchStatus: "fetching" });
  assert.equal(message(), "Checking cancellation permissions…");
  await update({ status: "success", fetchStatus: "idle" });
  assert.equal(message(), "Cancellation permissions are unknown.");
  await update({ status: "error", error: new Error("unavailable") });
  assert.equal(message(), "Unable to check cancellation permissions.");
  assert.ok(
    [...host.querySelectorAll("button")].some(
      (button) => button.textContent === "Retry authority check",
    ),
  );
  assert.equal(
    [...host.querySelectorAll("button")].some(
      (button) => button.textContent === "Cancel vesting",
    ),
    false,
  );
});

test("authorized cancellation keeps its button stable during permission refresh", async (t) => {
  const { host, client } = await mountDetail(t, { authority: true });
  const cancel = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Cancel vesting",
  )!;
  assert.ok(cancel && !cancel.disabled);
  const query = client.getQueryCache().find({
    queryKey: [
      "blast",
      "me",
      "vesting-eligibility",
      baseSchedule.schedule_id,
      beneficiary,
      null,
    ],
  })!;
  await act(async () => {
    query.setState({ fetchStatus: "fetching" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.ok(cancel.isConnected && cancel.disabled);
  assert.equal(cancel.getAttribute("aria-busy"), "true");
  await act(async () => {
    query.setState({ data: false, status: "success", fetchStatus: "idle" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(cancel.isConnected, false);
  assert.match(host.textContent!, /This wallet cannot cancel this vesting\./);
});

test("pending submission offers status checks without signing again", async (t) => {
  const execute = t.mock.fn(async () => ({ state: "submitted" }));
  const refresh = t.mock.fn(async () => ({ state: "submitted" }));
  const { host } = await mountDetail(t, {
    now: 1794868800000,
    execute,
    refresh,
  });
  const button = (label: string) =>
    [...document.querySelectorAll("button")].find(
      (button) => button.textContent === label,
    )!;
  await act(async () => button("Claim vested coins").click());
  await act(async () => button("Confirm in wallet").click());
  assert.match(document.body.textContent!, /Confirmation is pending/);
  assert.equal(document.querySelector('[role="alert"]'), null);
  await act(async () => button("Check transaction status").click());
  assert.equal(execute.mock.callCount(), 1);
  assert.equal(refresh.mock.callCount(), 1);
  assert.ok(host.querySelector("#vesting-claim-explanation"));
});

function activeReview() {
  return document.querySelector('[role="dialog"][aria-modal="true"]');
}

function reviewButton(label: string) {
  return [...(activeReview()?.querySelectorAll("button") ?? [])].find((button) => button.textContent === label);
}

for (const ambiguous of [false, true]) {
  test(ambiguous ? "lost submission response offers status only" : "wallet rejection returns to a fresh review", async (t) => {
    const { VestingReviewRequiredError, VestingSubmissionPendingError } = await import("./execute-reviewed");
    const execute = t.mock.fn(async () => { throw ambiguous ? new VestingSubmissionPendingError("Lost response") : new VestingReviewRequiredError("Wallet rejected"); });
    const refresh = t.mock.fn(async () => ({ state: "submitted" }));
    const { host } = await mountDetail(t, { now: 1794868800000, execute, refresh });
    const claim = [...host.querySelectorAll("button")].find((button) => button.textContent === "Claim vested coins");
    assert.ok(claim);
    await act(async () => claim.click());
    const confirm = await waitFor(() => reviewButton("Confirm in wallet"), "a review that can confirm in the wallet");
    await act(async () => confirm.click());
    await waitFor(() => execute.mock.callCount() === 1, "one wallet execution");
    if (ambiguous) {
      const checkStatus = await waitFor(() => reviewButton("Check transaction status"), "a status check after the lost response");
      await act(async () => checkStatus.click());
      await waitFor(() => refresh.mock.callCount() === 1, "one status refresh");
      assert.equal(execute.mock.callCount(), 1);
    } else {
      await waitFor(() => /Wallet rejected/.test(host.querySelector('[role="alert"]')?.textContent ?? ""), "the wallet rejection alert");
      await waitFor(() => activeReview() === null, "wallet rejection to close the active review");
      await act(async () => claim.click());
      await waitFor(() => reviewButton("Confirm in wallet"), "a new review that can confirm in the wallet");
    }
  });
}

test("dismissing a pending review reopens the same attempt without preparing again", async (t) => {
  const execute = t.mock.fn(async () => ({ state: "submitted" }));
  const refresh = t.mock.fn(async () => ({ state: "submitted" }));
  await mountDetail(t, { now: 1794868800000, execute, refresh });
  const globals = globalThis as unknown as { vestingTestWallet: { prepare: (...args: unknown[]) => unknown } };
  const prepare = t.mock.method(globals.vestingTestWallet, "prepare");
  const button = (label: string) => [...document.querySelectorAll("button")].find(button => button.textContent === label)!;
  await act(async () => button("Claim vested coins").click());
  await act(async () => button("Confirm in wallet").click());
  await act(async () => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  await act(async () => button("Check transaction status").click());
  await act(async () => button("Check transaction status").click());
  assert.equal(prepare.mock.callCount(), 1);
  assert.equal(execute.mock.callCount(), 1);
  assert.equal(refresh.mock.callCount(), 1);
  assert.match(document.querySelector('[role="dialog"]')!.textContent!, /View transaction/);
});

test("pending detail recovery belongs to its account and is restored on return", async (t) => {
  const refresh = t.mock.fn(async () => ({ state: "submitted" }));
  const { host, render } = await mountDetail(t, { now: 1794868800000, refresh });
  const globals = globalThis as unknown as { vestingTestWallet: { wallet: string; viewer: { signedIn: boolean; sessionIdentity?: string }; prepare: () => Promise<unknown> } };
  const original = globals.vestingTestWallet;
  const button = (label: string) => [...document.querySelectorAll("button")].find(button => button.textContent === label);
  await act(async () => button("Claim vested coins")!.click());
  await act(async () => button("Confirm in wallet")!.click());
  await act(async () => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  globals.vestingTestWallet = { ...original, viewer: { signedIn: true, sessionIdentity: "another-account" } };
  await act(async () => render());
  assert.equal(activeReview() === null, true, "the other account has no active review");
  assert.ok(button("Claim vested coins"));
  assert.equal(refresh.mock.callCount(), 0);
  globals.vestingTestWallet = original;
  await act(async () => render());
  assert.ok(button("Check transaction status"));
  await act(async () => button("Check transaction status")!.click());
  await act(async () => button("Check transaction status")!.click());
  assert.equal(refresh.mock.callCount(), 1);
  assert.ok(host.querySelector("#vesting-claim-explanation"));
});


test("unresolved authentication never asserts a settled sign-in requirement", async (t) => {
  const { host } = await mountDetail(t, { wallet: null, sessionPending: true });
  const explanation = host.querySelector("#vesting-cancel-explanation");
  assert.doesNotMatch(explanation?.textContent ?? "", /Sign in/);
  assert.match(explanation?.textContent ?? "", /Checking/);
  assert.equal([...host.querySelectorAll("button")].some(button => button.textContent === "Cancel vesting" && !button.disabled), false);
});


for (const signedIn of [false, true]) {
  test(`pending authentication blocks cached authority and claim (signedIn=${signedIn})`, async (t) => {
    const { host } = await mountDetail(t, { now: 1794868800000, sessionPending: true, signedIn, authority: true });
    assert.match(host.querySelector("#vesting-cancel-explanation")!.textContent!, /Checking cancellation permissions/);
    assert.match(host.querySelector("#vesting-claim-explanation")!.textContent!, /Checking your sign-in/);
    assert.ok(host.querySelector('#vesting-claim-explanation [role="status"][aria-label="Checking your sign-in…"]'));
    assert.ok(host.querySelector('#vesting-cancel-explanation [role="status"][aria-label="Checking cancellation permissions…"]'));
    assert.doesNotMatch(host.textContent!, /Sign in to claim/);
    const claim = [...host.querySelectorAll("button")].find(button => button.textContent === "Claim vested coins");
    assert.ok(claim?.disabled);
    assert.ok([...host.querySelectorAll("button")].filter(button => /Claim vested coins|Cancel vesting/.test(button.textContent ?? "")).every(button => button.disabled));
  });
}

test("confirmed signed-out cancellation guidance is separate from unresolved wallet and permission", async (t) => {
  const { host, client, render } = await mountDetail(t, { wallet: null, signedIn: false });
  const wallet = (globalThis as unknown as { vestingTestWallet: { wallet: string | null; viewer: { signedIn: boolean; sessionPending: boolean }; walletLoading: boolean } }).vestingTestWallet;
  const message = () => host.querySelector("#vesting-cancel-explanation")!.textContent!;
  assert.match(message(), /^Sign in/);
  await act(async () => { wallet.viewer.signedIn = true; wallet.walletLoading = true; render(); });
  assert.equal(message(), "Loading your wallet…");
  await act(async () => {
    wallet.walletLoading = false;
    wallet.wallet = beneficiary;
    client.setQueryData(["blast", "me", "vesting-eligibility", baseSchedule.schedule_id, beneficiary, null], true);
    render();
  });
  assert.equal(host.querySelector("#vesting-cancel-explanation"), null);
  const cancel = [...host.querySelectorAll("button")].find(button => button.textContent === "Cancel vesting");
  assert.ok(cancel && !cancel.disabled);
  assert.equal(cancel.getAttribute("aria-describedby"), null);
});

test("wallet, principal and schedule changes cannot reuse another permission result", async (t) => {
  const pending = Promise.withResolvers<Response>();
  t.mock.method(globalThis, "fetch", () => pending.promise);
  const { host, render } = await mountDetail(t, { authority: true });
  const wallet = (globalThis as unknown as { vestingTestWallet: { wallet: string; viewer: { signedIn: boolean; sessionIdentity?: string } } }).vestingTestWallet;
  const message = () => host.querySelector("#vesting-cancel-explanation")?.textContent;
  const granted = "Your wallet holds the cancellation key.";
  assert.equal(message(), undefined);
  assert.doesNotMatch(host.textContent!, /Cancelable · cancellation key required|Your wallet holds the cancellation key\./);
  assert.ok([...host.querySelectorAll("button")].some(button => button.textContent === "Cancel vesting" && !button.disabled));
  await act(async () => { wallet.wallet = otherWallet; render(); });
  assert.equal(message(), "Checking cancellation permissions…");
  assert.equal([...host.querySelectorAll("button")].some(button => button.textContent === "Cancel vesting" && !button.disabled), false);
  await act(async () => { wallet.wallet = beneficiary; wallet.viewer.sessionIdentity = "different-principal"; render(); });
  assert.equal(message(), "Checking cancellation permissions…");
  await act(async () => { wallet.viewer.sessionIdentity = undefined; render({ ...baseSchedule, schedule_id: `0x${"d".repeat(64)}` }); });
  assert.equal(message(), "Checking cancellation permissions…");
  assert.doesNotMatch(host.textContent!, new RegExp(granted));
});


test("an open transaction review cannot sign while its principal is hydrating", async (t) => {
  const execute = t.mock.fn(async () => { throw new Error("must not sign"); });
  const { host, render } = await mountDetail(t, { now: 1794868800000, execute });
  const wallet = (globalThis as unknown as { vestingTestWallet: { viewer: { signedIn: boolean; sessionPending?: boolean; sessionIdentity?: string } } }).vestingTestWallet;
  wallet.viewer.sessionIdentity = "fixture-owner";
  await act(async () => render());
  const claim = [...host.querySelectorAll("button")].find(button => button.textContent === "Claim vested coins")!;
  await act(async () => claim.click());
  const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Confirm in wallet")!;
  assert.ok(confirm && !confirm.disabled);
  await act(async () => { wallet.viewer.sessionPending = true; render(); });
  assert.equal(confirm.disabled, true);
  await act(async () => confirm.click());
  assert.equal(execute.mock.callCount(), 0);
});


for (const indexed of [true, false]) {
  test(`empty activity is omitted (indexed=${indexed})`, async (t) => {
    const { host } = await mountDetail(t, { schedule: { ...baseSchedule, indexed } });
    assert.ok(![...host.querySelectorAll("h2")].some(heading => heading.textContent === "Activity"));
    assert.doesNotMatch(host.textContent!, /No lifecycle events|indexing catches up/);
  });
}

test("missing release data omits optional figures and chart while explaining the disabled claim", async (t) => {
  const { host } = await mountDetail(t, {
    schedule: { ...baseSchedule, terms: { kind: "checkpoints", checkpoints: null, checkpoint_count: "1" } },
  });
  assert.ok(![...host.querySelectorAll("dt")].some(label => label.textContent === "Locked"));
  assert.equal(host.querySelector('[aria-label^="Inspect full claimable amount:"]'), null);
  assert.ok(![...host.querySelectorAll("h3")].some(heading => heading.textContent === "Release schedule"));
  assert.doesNotMatch(host.textContent!, /Release dates are unavailable|—/);
  assert.match(host.querySelector("#vesting-claim-explanation")!.textContent!, /release data is unavailable/);
});

test("real activity, cliff dates and confirmed gas information remain visible", async (t) => {
  const schedule = { ...baseSchedule, terms: { ...baseSchedule.terms, kind: "linear" as const, start_ms: "1792276800000", period_ms: "2592000000", periods: "12", cliff_ms: "1000" } };
  const { host, client, render } = await mountDetail(t, { schedule, now: 1794868800000 });
  assert.ok([...host.querySelectorAll("dt")].some(label => label.textContent === "Cliff"));
  assert.doesNotMatch(host.textContent!, /At the cliff|Review network gas before signing/);
  const wallet = (globalThis as unknown as { vestingTestWallet: { fee?: string } }).vestingTestWallet;
  await act(async () => {
    wallet.fee = "sponsored";
    client.setQueryData(["vesting", schedule.schedule_id], { now_ms: 1794868800000, schedule, events: [{ event_id: "created", kind: "created", timestamp_ms: schedule.terms.start_ms, digest: "test-digest", payload: {} }] });
    render();
  });
  assert.match(host.textContent!, /Gas covered by Blast/);
  assert.match(host.textContent!, /Vesting created/);
  assert.ok(host.querySelector('a[href="https://suiscan.xyz/mainnet/tx/test-digest"]'));
});
