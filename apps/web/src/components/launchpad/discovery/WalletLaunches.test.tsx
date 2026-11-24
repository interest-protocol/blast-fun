import assert from "node:assert/strict";
import test from "node:test";

import type { WalletLaunchesResponse } from "@blast/core/modules/launchpad-discovery/rows.ts";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";
installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { WalletLaunches } = await import("./WalletLaunches");

const WALLET = `0x${"a1".repeat(32)}`;
const LAUNCH = `0x${"c3".repeat(32)}`;
const COIN_LINK = `a[href="/coin/${LAUNCH}%3A%3Afroggy%3A%3AFROGGY"]`;
const provenance = { source: "blast-infra", network: "mainnet", deployment: "d", checkpoint: 7, timestampMs: 1, observedAt: 1, lagMs: 0 } as const;

function row(launchId: string, lifecycle: "live" | "migrated") {
  return {
    launchId,
    coinType: `${launchId}::froggy::FROGGY`,
    quoteType: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
    lifecycle,
    name: "Froggy",
    symbol: "FROG",
    iconUrl: null,
    createdAtMs: 1_790_000_000_000,
    graduatedAtMs: lifecycle === "migrated" ? 1_790_100_000_000 : null,
    quoteRemaining: null,
    quoteDecimals: 9,
    progressBps: null,
    partner: null,
  } as const;
}

async function mount(read: (address: string, cursor: string | null) => Promise<WalletLaunchesResponse | null>, t: test.TestContext) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () => root.render(<WalletLaunches addresses={[WALLET]} read={read} />));
  return container;
}

test("a wallet's launches are discovery rows linking to their coins, every lifecycle shown, and load more on request", async (t) => {
  const asked: (string | null)[] = [];
  const read = async (address: string, cursor: string | null): Promise<WalletLaunchesResponse> => {
    assert.equal(address, WALLET);
    asked.push(cursor);
    return cursor === null
      ? { section: { state: "available", data: { rows: [row(LAUNCH, "migrated")], nextCursor: "next" }, provenance } }
      : { section: { state: "available", data: { rows: [row(`0x${"d4".repeat(32)}`, "live")], nextCursor: null }, provenance } };
  };
  const container = await mount(read, t);
  const link = container.querySelector(COIN_LINK);
  assert.ok(link, "each row links to its coin");
  assert.match(link.textContent ?? "", /FROG.*Froggy.*Graduated/);
  const more = [...container.querySelectorAll("button")].find((button) => button.textContent === "Load more launches");
  assert.ok(more);
  await act(async () => more.click());
  assert.deepEqual(asked, [null, "next"]);
  assert.equal(container.querySelectorAll("li").length, 2);
  assert.match(container.textContent ?? "", /Live/);
});

test("an empty list is said only after a read that answered empty; a failed read is Unavailable, never empty", async (t) => {
  const empty = await mount(async () => ({ section: { state: "empty", provenance } }), t);
  assert.match(empty.textContent ?? "", /Launch a coin/);
  let answer: WalletLaunchesResponse | null = null;
  const failed = await mount(async () => answer, t);
  assert.match(failed.textContent ?? "", /Unavailable/);
  assert.doesNotMatch(failed.textContent ?? "", /Launch a coin/);
  // Refresh retries the first page, and leaves once the list is current.
  answer = { section: { state: "available", data: { rows: [row(LAUNCH, "live")], nextCursor: null }, provenance } };
  const refresh = [...failed.querySelectorAll("button")].find((button) => button.textContent === "Refresh");
  assert.ok(refresh, "a failed list offers Refresh");
  await act(async () => refresh.click());
  assert.ok(failed.querySelector(COIN_LINK));
  assert.ok(![...failed.querySelectorAll("button")].some((button) => button.textContent === "Refresh"));
});

test("a rejected wallet read offers recovery and a rejected refresh always releases its busy state", async (t) => {
  let reject = true;
  const container = await mount(async () => {
    if (reject) throw new Error("offline");
    return { section: { state: "empty", provenance } };
  }, t);
  const refresh = () => [...container.querySelectorAll("button")].find(button => button.textContent === "Refresh")!;
  assert.match(container.textContent ?? "", /Unavailable/);
  await act(async () => refresh().click());
  assert.equal(refresh().disabled, false);
  assert.equal(refresh().getAttribute("aria-busy"), null);
  reject = false;
  await act(async () => refresh().click());
  assert.match(container.textContent ?? "", /Launch a coin/);
});

test("an old wallet reader cannot replace a newer reader's result", async (t) => {
  let finish!: (value: WalletLaunchesResponse | null) => void;
  const oldRead = () => new Promise<WalletLaunchesResponse | null>(resolve => { finish = resolve; });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => root.render(<WalletLaunches addresses={[WALLET]} read={oldRead} />));
  const freshRead = async (): Promise<WalletLaunchesResponse> => ({ section: { state: "available", data: { rows: [row(LAUNCH, "live")], nextCursor: null }, provenance } });
  await act(async () => root.render(<WalletLaunches addresses={[WALLET]} read={freshRead} />));
  await act(async () => finish({ section: { state: "empty", provenance } }));
  assert.ok(container.querySelector(COIN_LINK));
  assert.doesNotMatch(container.textContent ?? "", /Launch a coin/);
});

test("changing readers during a manual refresh clears the previous reader's busy state", async (t) => {
  let finish!: (value: WalletLaunchesResponse | null) => void;
  let asked = 0;
  const oldRead = async () => ++asked === 1 ? null : new Promise<WalletLaunchesResponse | null>(resolve => { finish = resolve; });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const refresh = () => [...container.querySelectorAll("button")].find(button => button.textContent === "Refresh")!;
  await act(async () => root.render(<WalletLaunches addresses={[WALLET]} read={oldRead} />));
  const pendingButton = refresh();
  await act(async () => pendingButton.click());
  assert.equal(pendingButton.getAttribute("aria-busy"), "true");
  const freshRead = async () => null;
  await act(async () => root.render(<WalletLaunches addresses={[WALLET]} read={freshRead} />));
  assert.equal(refresh().getAttribute("aria-busy"), null);
  await act(async () => finish({ section: { state: "empty", provenance } }));
  assert.match(container.textContent ?? "", /Unavailable/);
  assert.equal(refresh().disabled, false);
});
