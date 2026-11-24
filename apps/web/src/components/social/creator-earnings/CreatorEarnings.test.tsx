import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";
import type { CreatorEarning } from "@blast/core/modules/social/contracts/creator-earnings.ts";
import type { Claims } from "../claim/use-claims";
import type { ClaimTarget, ClaimView } from "../claim/claims";
import type { CreatorEarningsRead } from "./use-creator-earnings";
import { earningAmount } from "./earning-amount";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { CreatorEarnings } = await import("./CreatorEarnings");
const row: CreatorEarning = {
  presale_id: `0x${"1".repeat(64)}`,
  vault_id: `0x${"2".repeat(64)}`,
  name: "Creator coin",
  symbol: "CC",
  icon_url: "",
  quote_symbol: "SUI",
  fee_share_bps: 4500,
  collection_status: "ready",
  collect: { meme: "12.34567", quote: "0.5" },
  residuals: { meme: "0.000000051", quote: "0.000782261" },
  received: { meme: "495176.06706", quote: "0.3" },
};
const base: CreatorEarningsRead = {
  status: "ready",
  earnings: [row],
  vestings: [],
  error: "Try again.",
  retry: () => undefined,
  more: false,
  loadingMore: false,
  refreshing: false,
  refreshFailed: false,
  loadMore: () => undefined,
};
let unmount: (() => Promise<void>) | undefined;
afterEach(async () => {
  await unmount?.();
  unmount = undefined;
});

async function render(read: CreatorEarningsRead = base, view: ClaimView = { state: "idle" }) {
  const targets: ClaimTarget[] = [];
  const claims: Claims = {
    available: true,
    supports: () => true,
    view: () => view,
    run: (target) => targets.push(target),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  const update = async (next = read, hidden = false, nextView = view) => {
    view = nextView;
    await act(async () =>
      root.render(<CreatorEarnings claims={claims} hidden={hidden} read={next} />),
    );
  };
  await update();
  return { container, update, targets };
}

test("amounts retain precision, distinguish tiny positives, and mark only approximations", () => {
  assert.equal(earningAmount("0"), "0");
  assert.equal(earningAmount("0.000000051"), "<0.000001");
  assert.equal(earningAmount("0.000001"), "0.000001");
  assert.equal(earningAmount("0.000782261"), "≈0.000782");
  assert.equal(earningAmount("495176.06706"), "≈495,176.07");
  assert.equal(earningAmount("12.34", true), "≈12.34");
  assert.equal(
    earningAmount("18446744073709551615.123456789", false, true),
    "18,446,744,073,709,551,615.123456789",
  );
  assert.equal(earningAmount("0.000000051", false, true), "0.000000051");
});

test("details preserve exact balances and expansion during refresh, including privacy masking", async () => {
  const { container, update } = await render();
  assert.doesNotMatch(
    container.textContent!,
    /Claim creator allocations|Amounts estimated|Collected so far/,
  );
  const disclosure = container.querySelector<HTMLButtonElement>(
    '[aria-label="CC earnings details"]',
  )!;
  const details = document.getElementById(disclosure.getAttribute("aria-controls")!)!;
  assert.equal(details.hidden, true);
  assert.match(container.textContent!, /<0.000001 CC/);
  await act(async () => disclosure.click());
  assert.equal(disclosure.getAttribute("aria-expanded"), "true");
  assert.equal(details.hidden, false);
  assert.match(details.textContent!, /Fee share45%/);
  assert.doesNotMatch(details.textContent!, /Collect distributes|Available fees are your wallet/);
  assert.match(details.textContent!, /495,176.06706 CC/);
  assert.match(details.textContent!, /0.000000051 CC/);
  await update({ ...base, refreshing: true });
  assert.equal(disclosure.getAttribute("aria-expanded"), "true");
  assert.equal(
    container
      .querySelector('[aria-label="Refreshing creator earnings"]')!
      .getAttribute("aria-busy"),
    "true",
  );
  assert.equal(details.hidden, false);
  await update({ ...base, refreshFailed: true });
  assert.match(
    container.querySelector('[role="alert"]')!.textContent!,
    /Showing the last known amounts/,
  );
  await update(base, true);
  assert.doesNotMatch(container.textContent!, /495,176|0.000000051|12.34567|0.000782/);
});

test("an unavailable fee preview leaves the independent leftovers claim usable and correctly bound", async () => {
  const { container, targets } = await render({
    ...base,
    earnings: [{ ...row, collect: null, collection_status: "unavailable" }],
  });
  assert.match(container.textContent!, /Fees unavailable/);
  const collect = container.querySelector<HTMLButtonElement>('[data-claim="collect_fees"]')!;
  assert.equal(collect.disabled, true);
  await act(async () => collect.click());
  assert.equal(targets.length, 0);
  const claim = container.querySelector<HTMLButtonElement>(
    '[aria-label="Claim CC launch leftovers"]',
  )!;
  await act(async () => claim.click());
  assert.equal(targets.length, 1);
  assert.equal(targets[0]!.vaultId, row.vault_id);
  assert.equal(targets[0]!.kind, "claim_residuals");
});

test("collection keeps a stable pending action, prevents repeats, and recovers after failure", async () => {
  const { container, targets, update } = await render();
  const collect = () =>
    container.querySelector<HTMLButtonElement>('[data-claim="collect_fees"]')!;
  assert.equal(collect().textContent, "Collect");
  await act(async () => collect().click());
  assert.equal(targets.length, 1);

  await update(base, false, { state: "claiming" });
  assert.equal(collect().getAttribute("aria-busy"), "true");
  assert.equal(collect().getAttribute("aria-disabled"), "true");
  assert.ok(
    collect().querySelector(
      '[role="status"][aria-label="Collecting fees · Collect CC trading fees"]',
    ),
  );
  const visible = collect().cloneNode(true) as HTMLElement;
  visible.querySelectorAll('[aria-hidden="true"], .srOnly').forEach((node) => node.remove());
  assert.equal(
    visible.textContent,
    "",
    "pending actions show an indicator instead of overflowing progress text",
  );
  await act(async () => collect().click());
  assert.equal(targets.length, 1);

  await update(base, false, {
    state: "failed",
    code: "service_unavailable",
    message: "Nothing was claimed. Try again.",
  });
  assert.equal(collect().textContent, "Collect");
  assert.equal(collect().getAttribute("aria-busy"), null);
  assert.match(container.querySelector('[role="alert"]')!.textContent!, /Nothing was claimed/);
  await act(async () => collect().click());
  assert.equal(targets.length, 2);

  await update(base, false, { state: "claiming" });
  await update(base, false, { state: "done", digest: "confirmed-collection" });
  assert.equal(container.querySelector('[data-claim="collect_fees"]'), null);
  assert.equal(
    container.querySelector('[data-claim-complete="collect_fees"]')!.textContent,
    "Collected",
  );
  assert.equal(
    container.querySelector<HTMLButtonElement>('button[data-claim-complete="collect_fees"]')!.disabled,
    true,
  );
  assert.equal(container.querySelector('[role="alert"]'), null);
  assert.doesNotMatch(container.textContent!, /Updating/);
});

test("zero and unavailable reads remain distinct, with local actionable failure feedback", async () => {
  const { container, update } = await render(base, {
    state: "failed",
    code: "service_unavailable",
    message: "Nothing was claimed. Try again.",
  });
  assert.match(
    container.querySelector('[role="alert"]')!.textContent!,
    /Nothing was claimed. Try again/,
  );
  await update({
    ...base,
    earnings: [{ ...row, collect: null, residuals: null, collection_status: "empty" }],
  });
  const zeroAmounts = container.querySelector('[class="value"]')!;
  assert.match(zeroAmounts.textContent!, /0 CC/);
  assert.match(zeroAmounts.textContent!, /0 SUI/);
  assert.match(container.textContent!, /Nothing to claim/);
  const collect = container.querySelector<HTMLButtonElement>('[data-claim="collect_fees"]')!;
  assert.equal(collect.textContent, "Collect");
  assert.equal(collect.disabled, true);
  assert.equal(container.querySelector('[data-claim="claim_residuals"]'), null);
  await update(base, false, { state: "idle" });
  assert.equal(collect.disabled, false, "collection becomes available when fees arrive");
  await update({ ...base, status: "loading", earnings: [] });
  assert.ok(container.querySelector('[aria-label="Loading creator earnings"]'));
  assert.doesNotMatch(container.textContent!, /Nothing to claim|0 CC/);
});

test("fee help remains available and Collect preserves its vault binding without the removed copy", async () => {
  const { container, targets } = await render();
  const collect = container.querySelector<HTMLButtonElement>(
    '[aria-label="Collect CC trading fees"]',
  )!;
  assert.doesNotMatch(container.textContent!, /Collect distributes fees to all recipients/);
  assert.equal(collect.getAttribute("aria-describedby"), null);
  assert.equal(
    container
      .querySelector('[aria-label="Claim CC launch leftovers"]')!
      .getAttribute("aria-describedby"),
    null,
  );
  assert.ok(container.querySelector('[aria-label="CC trading fee estimate help"]'));
  await act(async () => collect.click());
  assert.equal(targets[0]!.kind, "collect_fees");
  assert.equal(targets[0]!.vaultId, row.vault_id);
  assert.equal(targets[0]!.collection!.received, `${row.received.meme}:${row.received.quote}`);
});

test("read loading uses a pending panel and pagination keeps existing earnings", async () => {
  const { container, update } = await render({ ...base, status: "loading", earnings: [] });
  const visibleText = () => {
    const copy = container.cloneNode(true) as HTMLElement;
    copy
      .querySelectorAll('[aria-hidden="true"], [hidden], .sr-only')
      .forEach((node) => node.remove());
    return copy.textContent!;
  };
  const skeleton = container.querySelector('[role="status"][aria-label="Loading creator earnings"]')!;
  assert.equal(skeleton.getAttribute("aria-busy"), "true");
  assert.equal(skeleton.querySelector(".action, .amounts"), null);
  assert.equal(
    skeleton.querySelectorAll("button, a").length,
    0,
    "placeholder actions are not interactive",
  );
  assert.doesNotMatch(visibleText(), /loading|updating|123\.456/i);
  await update({ ...base, more: true, loadingMore: true });
  assert.match(visibleText(), /Creator coin/);
  assert.ok(container.querySelector('[aria-label="Loading creator earnings"]'));
  const more = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Load more",
  )!;
  assert.equal(more.disabled, true);
  assert.equal(more.getAttribute("aria-busy"), "true");
  assert.doesNotMatch(visibleText(), /loading|updating/i);
  await update({ ...base, refreshing: true });
  assert.equal(container.querySelector('[aria-label="Loading creator earnings"]'), null);
  assert.match(visibleText(), /Creator coin/);
  assert.doesNotMatch(visibleText(), /loading|updating/i);
});
