import assert from "node:assert/strict";
import test from "node:test";
import { ActivityHints } from "../home/activity-hints.ts";
import type { FreshnessSignal } from "../home/feed-freshness.ts";

import { COIN_FIXTURE } from "../../../../../../packages/core/test/fixtures/modules/launchpad-coin/fixtures.ts";
import { walletHolderRewardsBody, walletLaunchRewardsBody } from "../../../../../../packages/core/test/fixtures/modules/launchpad-coin/rewards-fixtures.ts";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";
installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { browserMarketDependencies } = await import("../../launchpad/blast-infra-browser");
const { LaunchRewards } = await import("./LaunchRewards");

const WALLET = `0x${"a1".repeat(32)}`;
const NOW = Date.now();

type Answer = "migrated" | "live" | "empty" | "down" | "holder-refused";

/** This app's market routes, answering a wallet's reads as `answer` says. */
function market(result: Answer | (() => Answer), seen: string[] = []) {
  return browserMarketDependencies(null, (async (input: RequestInfo | URL) => {
    const path = String(input);
    const answer = typeof result === "function" ? result() : result;
    seen.push(path);
    if (path === "/api/launchpad/market/status") return Response.json({ provenance: walletHolderRewardsBody(WALLET, NOW).provenance });
    if (answer === "down") return Response.json({ error: { code: "unavailable", message: "x" } }, { status: 503 });
    if (path.startsWith(`/api/launchpad/market/wallets/${WALLET}/launch-rewards`)) {
      const body = walletLaunchRewardsBody(WALLET, answer === "empty" || answer === "holder-refused" ? "live" : answer, NOW);
      return Response.json(answer === "empty" ? { ...body, launches: [] } : body);
    }
    if (path.startsWith(`/api/launchpad/market/wallets/${WALLET}/vault-rewards`)) {
      if (answer === "holder-refused") return Response.json({ error: { code: "unauthorized", message: "x" } }, { status: 401 });
      const body = walletHolderRewardsBody(WALLET, NOW);
      return Response.json(answer === "empty" ? { ...body, payouts: [] } : body);
    }
    return Response.json({ error: { code: "not_found", message: "x" } }, { status: 404 });
  }) as typeof fetch);
}

type MountOptions = Readonly<{
  hidden?: boolean;
  active?: boolean;
  seen?: string[];
  addresses?: readonly string[] | null;
  claims?: import("../claim/use-claims").Claims;
  claimWallet?: string | null;
}>;

async function mount(answer: Answer, t: test.TestContext, options: MountOptions = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <LaunchRewards
        addresses={options.addresses === undefined ? [WALLET] : options.addresses}
        active={options.active ?? true}
        hidden={options.hidden ?? false}
        market={market(answer, options.seen)}
        claims={options.claims}
        claimWallet={options.claimWallet}
      />,
    ),
  );
  // Let each read answer.
  for (let tick = 0; tick < 5; tick += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  return container.textContent ?? "";
}

test("a graduated launch's creator fees show both ledgers apart, and the holder rewards are a section of their own", async (t) => {
  const words = await mount("migrated", t);
  assert.match(words, /Launchpad creator fees/);
  assert.match(words, /Froggy/);
  assert.match(words, /Bonding curve, until migration/);
  assert.match(words, /Migration vault, since migration/);
  // The coin page's words for the same figures.
  assert.match(words, /Earned.*Claimed.*Unclaimed.*9,800/);
  assert.match(words, /Launchpad holder rewards.*Round 1 · .*Received— FROGGY0\.02 SUI/);
  const payoutTime = document.querySelector('[aria-label^="Inspect full payout time:"] time');
  assert.equal(payoutTime?.getAttribute("datetime"), new Date(1_790_170_000_001).toISOString());
  assert.doesNotMatch(words, /40000000 atoms/);
});

test("before migration a launch has only its curve's ledger; the eye masks every amount", async (t) => {
  const words = await mount("live", t);
  assert.match(words, /Bonding curve/);
  assert.doesNotMatch(words, /Migration vault/);
  const masked = await mount("migrated", t, { hidden: true });
  assert.doesNotMatch(masked, /9,800|14,000/);
  assert.match(masked, /••••/);
});

test("empty is said only after a read that answered empty; a failed read offers a retry, never empty", async (t) => {
  const empty = await mount("empty", t);
  assert.match(empty, /No creator fees yet/);
  assert.match(empty, /No holder rewards yet/);
  const down = await mount("down", t);
  // The error says why, then how to recover.
  assert.match(down, /Launchpad creator fees could not loadNothing changed: blast-infra could not answer \(unavailable\)\. Try again in a moment\./);
  assert.doesNotMatch(down, /No creator fees yet/);
});

test("while the reader's wallets are unknown both lists are pending, shaped like their rows, and nothing is read", async (t) => {
  const seen: string[] = [];
  await mount("migrated", t, { addresses: null, seen });
  assert.deepEqual(seen, []);
  const pending = [...document.querySelectorAll('[role="status"]')].map((status) => status.getAttribute("aria-label"));
  assert.deepEqual(pending, ["Loading launchpad creator fees", "Loading launchpad holder rewards"]);
  assert.equal(document.querySelectorAll("button").length, 0);
});

test("with several wallets each heading names its wallet, whole to a screen reader", async (t) => {
  const other = `0x${"b2".repeat(32)}`;
  const words = await mount("empty", t, { addresses: [WALLET, other] });
  assert.match(words, new RegExp(`Launchpad creator fees · 0xa1a1…a1a1, wallet ${WALLET}`));
  assert.match(words, new RegExp(`Launchpad holder rewards · 0xb2b2…b2b2, wallet ${other}`));
});

test("nothing is read for a reader who is not signed in", async (t) => {
  const seen: string[] = [];
  await mount("migrated", t, { active: false, seen });
  assert.deepEqual(seen, []);
});

/** A claim path's state as a screen reads it: what each key shows, and what ran. */
function fakeClaims(views: Map<string, import("../claim/claims").ClaimView> = new Map()) {
  const ran: import("../claim/claims").ClaimTarget[] = [];
  const claims: import("../claim/use-claims").Claims = {
    available: true,
    supports: () => true,
    view: (key) => views.get(key) ?? { state: "idle" },
    run: (target) => void ran.push(target),
  };
  return { claims, ran };
}

test("LP-12: the Blast wallet claims each ledger with something unclaimed in place; other wallets' rows are shown, not claimed", async (t) => {
  const { claims, ran } = fakeClaims();
  await mount("migrated", t, { claims, claimWallet: WALLET });
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("button[data-claim]")];
  assert.deepEqual(buttons.map((button) => [button.dataset.claim, button.getAttribute("aria-label")]), [
    ["claim_launch_fees", "Claim FROGGY creator fees from the bonding curve"],
    ["claim_launch_lp_fees", "Claim FROGGY creator fees from the migration vault"],
  ]);
  await act(async () => buttons[1]!.click());
  assert.equal(ran.length, 1);
  assert.deepEqual([ran[0]!.kind, ran[0]!.key, ran[0]!.collection], ["claim_launch_lp_fees", `launch-lp-fees:${COIN_FIXTURE.launchId}`, { received: "400000000:200000000" }]);
});

test("LP-12: no claim without a claim path, for another wallet, or for a ledger with nothing unclaimed", async (t) => {
  await mount("migrated", t, { claimWallet: WALLET });
  assert.equal(document.querySelectorAll("button[data-claim]").length, 0, "no claim path");
  await mount("migrated", t, { claims: fakeClaims().claims, claimWallet: `0x${"b2".repeat(32)}` });
  assert.equal(document.querySelectorAll("button[data-claim]").length, 0, "another wallet signs");
});

test("LP-12: once a claim answers, the rows are read again: their figures are the server's", async (t) => {
  const signals = new Set<FreshnessSignal>();
  const original = globalThis.EventSource;
  globalThis.EventSource = class {} as unknown as typeof EventSource;
  t.after(() => { globalThis.EventSource = original; });
  t.mock.method(ActivityHints.prototype, "subscribe", (_name: string, next: FreshnessSignal) => {
    signals.add(next);
    return () => { signals.delete(next); };
  });
  const seen: string[] = [];
  const views = new Map<string, import("../claim/claims").ClaimView>();
  const first = fakeClaims(views);
  const view = first.claims.view;
  const receiptAware = { ...first.claims, view: (key: string, claimed?: string, received?: string): ClaimView =>
    received === "4200000000:61000000" ? { state: "idle" } : view(key, claimed, received) };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  let indexed = false;
  const dependencies = market(() => indexed ? "migrated" : "live", seen);
  const render = (claims: import("../claim/use-claims").Claims) =>
    act(async () => root.render(<LaunchRewards addresses={[WALLET]} active hidden={false} market={dependencies} claims={claims} claimWallet={WALLET} />));
  await render(receiptAware);
  for (let tick = 0; tick < 5; tick += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  const reads = () => seen.filter((path) => path.includes("/launch-rewards")).length;
  const before = reads();
  assert.ok(document.querySelector('button[data-claim="claim_launch_fees"]'));
  views.set(`launch-fees:${COIN_FIXTURE.launchId}`, { state: "done", digest: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" });
  await render({ ...receiptAware });
  for (let tick = 0; tick < 5; tick += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  assert.equal(reads(), before + 1);
  assert.equal(signals.size, 1);
  indexed = true;
  await act(async () => signals.forEach((signal) => signal({ atMs: Date.now(), cause: "hint" })));
  for (let tick = 0; tick < 5; tick += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  assert.equal(signals.size, 0, "the indexed receipt stops the ledger watch");
  const settledReads = reads();
  await act(async () => signals.forEach((signal) => signal({ atMs: Date.now(), cause: "hint" })));
  assert.equal(reads(), settledReads);
});


// --- LP-17: creator rights ------------------------------------------------------------------------

const { creatorClaimsBody, pendingCreatorClaimRow } = await import("../../../../../../packages/core/test/fixtures/modules/launchpad-coin/rewards-fixtures.ts");
const COMMITMENT = "7c".repeat(32);
const OTHER_WALLET = `0x${"b2".repeat(32)}`;
const claimCoinType = (id: string) => id === COIN_FIXTURE.launchId ? COIN_FIXTURE.coinType : `${id}::froggy::FROGGY`;
const ACCOUNT_LAUNCH = `0x${"a3".repeat(32)}`;
type ClaimView = import("../claim/claims").ClaimView;
type Claims = import("../claim/use-claims").Claims;

/**
 * This app's market routes for the creator-rights reads: the wallet's pending claims (`wallet`),
 * the account's (`account`), each a list of launch ids or "down"; and the Blast wallet's fees,
 * with the curve's cap once `capHeld` says so. Every request is recorded.
 */
const { encodeCursor } = await import("@blast/core/modules/launchpad-contract/cursor.ts");
const { creatorClaimsCursor } = await import("@blast/core/modules/launchpad-contract/rewards.ts");
const ACCOUNT_NEXT = encodeCursor(creatorClaimsCursor({ kind: "account", commitment: COMMITMENT }), [], ["00000000000326000009", "00000000000000000001", "00000000000000000001"]);

function rightsMarket(state: { wallet: readonly string[] | "down"; account: readonly string[] | "down"; capHeld: boolean; accountMore?: readonly string[] }, seen: string[]) {
  return browserMarketDependencies(null, (async (input: RequestInfo | URL) => {
    const path = String(input);
    seen.push(path);
    if (path === "/api/launchpad/market/status") return Response.json({ provenance: walletHolderRewardsBody(WALLET, NOW).provenance });
    const pending = (ids: readonly string[]) => ids.map((id, index) => ({ ...pendingCreatorClaimRow(id, `32600000${9 - index}:1:1:0`), coin: claimCoinType(id) }));
    if (path.startsWith(`/api/launchpad/market/creator-claims?recipient=${WALLET}`)) {
      if (state.wallet === "down") return Response.json({ error: { code: "unavailable", message: "x" } }, { status: 503 });
      return Response.json(creatorClaimsBody({ kind: "address", address: WALLET }, NOW, pending(state.wallet)));
    }
    if (path.startsWith(`/api/launchpad/market/creator-claims?account=${COMMITMENT}`)) {
      if (state.account === "down") return Response.json({ error: { code: "unavailable", message: "x" } }, { status: 503 });
      const account = { kind: "account", commitment: COMMITMENT } as const;
      // A second page, older than the first's one row.
      if (path.includes("cursor=")) return Response.json(creatorClaimsBody(account, NOW, (state.accountMore ?? []).map((id) => ({ ...pendingCreatorClaimRow(id, "325000000:1:1:0"), coin: claimCoinType(id) }))));
      if (state.accountMore) return Response.json(creatorClaimsBody(account, NOW, pending(state.account), ACCOUNT_NEXT));
      return Response.json(creatorClaimsBody({ kind: "account", commitment: COMMITMENT }, NOW, pending(state.account)));
    }
    if (path.startsWith(`/api/launchpad/market/wallets/${WALLET}/launch-rewards`)) {
      const body = walletLaunchRewardsBody(WALLET, "live", NOW) as { launches: Record<string, unknown>[] };
      return Response.json({ ...body, launches: body.launches.map((row) => ({ ...row, entitled_by: state.capHeld ? "curve_fee_cap" : "creator" })) });
    }
    if (path.includes("/launch-rewards") || path.includes("/vault-rewards")) {
      const body = walletHolderRewardsBody(OTHER_WALLET, NOW);
      return Response.json(path.includes("vault") ? { ...body, wallet: path.split("/")[5], payouts: [] } : { address: path.split("/")[5], launches: [], next_cursor: null, provenance: body.provenance });
    }
    return Response.json({ error: { code: "not_found", message: "x" } }, { status: 404 });
  }) as typeof fetch);
}

async function mountRights(
  t: test.TestContext,
  state: Parameters<typeof rightsMarket>[0],
  options: Readonly<{
    claims?: Claims;
    account?: import("./LaunchRewards").CreatorAccountRead;
    wallet?: import("./LaunchRewards").CreatorWalletRead;
    seen?: string[];
  }> = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const dependencies = rightsMarket(state, options.seen ?? []);
  const render = async (claims: Claims | undefined, account = options.account ?? { status: "ready", commitment: COMMITMENT } as const) => {
    await act(async () =>
      root.render(
        <LaunchRewards
          addresses={[WALLET, OTHER_WALLET]}
          active
          hidden={false}
          market={dependencies}
          claims={claims}
          claimWallet={WALLET}
          creatorAccount={account}
          creatorWallet={options.wallet}
        />,
      ),
    );
    for (let tick = 0; tick < 5; tick += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  };
  await render(options.claims);
  return { container, render };
}

const rightsButtons = () => [...document.querySelectorAll<HTMLButtonElement>('button[data-claim="claim_creator_caps"]')];

test("LP-17: launches naming the Blast wallet and launches naming the account each offer their creator rights; another wallet is not asked", async (t) => {
  const seen: string[] = [];
  const { claims, ran } = fakeClaims();
  const { container } = await mountRights(t, { wallet: [COIN_FIXTURE.launchId], account: [ACCOUNT_LAUNCH], capHeld: false }, { claims, seen });
  assert.match(container.textContent ?? "", /Launchpad creator rights/);
  assert.deepEqual(rightsButtons().map((button) => button.getAttribute("aria-label")), ["Claim FROGGY creator rights", "Claim FROGGY creator rights"]);
  assert.equal(rightsButtons()[0]!.textContent, "Claim rights");
  await act(async () => rightsButtons()[0]!.click());
  await act(async () => rightsButtons()[1]!.click());
  assert.deepEqual(ran.map((target) => [target.kind, target.key, "launchId" in target ? target.launchId : null]).sort(), [
    ["claim_creator_caps", `creator-caps:${ACCOUNT_LAUNCH}`, ACCOUNT_LAUNCH],
    ["claim_creator_caps", `creator-caps:${COIN_FIXTURE.launchId}`, COIN_FIXTURE.launchId],
  ].sort());
  // Label and action only: no status text that a finished claim would contradict.
  assert.doesNotMatch(container.textContent ?? "", /Not claimed yet/);
  const asked = seen.filter((path) => path.includes("/creator-claims"));
  assert.ok(asked.some((path) => path.startsWith(`/api/launchpad/market/creator-claims?recipient=${WALLET}&`)));
  assert.ok(asked.some((path) => path.startsWith(`/api/launchpad/market/creator-claims?account=${COMMITMENT}&`)));
  assert.ok(!asked.some((path) => path.includes(OTHER_WALLET)), "another linked wallet's launches are not offered");
  // Before its caps are claimed, the launch's fees have no claim: the wallet holds no cap yet.
  assert.equal(document.querySelectorAll('button[data-claim="claim_launch_fees"]').length, 0);
});

test("LP-17: no section only after every read answered empty; a pending read is a pending row, a failed one a retry", async (t) => {
  const pendingRow = () => [...document.querySelectorAll('[role="status"]')].map((status) => status.getAttribute("aria-label")).filter((label) => label?.includes("creator rights"));
  await mountRights(t, { wallet: [], account: [], capHeld: false }, { claims: fakeClaims().claims });
  assert.doesNotMatch(document.body.textContent ?? "", /creator rights/i);
  // The account's commitment, or the Blast wallet, not known yet: pending, never "none".
  for (const options of [{ account: { status: "loading" } as const }, { wallet: { status: "loading" } as const }]) {
    const { container } = await mountRights(t, { wallet: [], account: [], capHeld: false }, options);
    assert.match(container.textContent ?? "", /Launchpad creator rights/);
    assert.deepEqual(pendingRow(), ["Loading launchpad creator rights"]);
    await act(async () => container.remove());
  }
  // An account without a Blast wallet has only its account's list.
  const walletless = await mountRights(t, { wallet: "down", account: [], capHeld: false }, { wallet: { status: "ready", address: null } });
  assert.doesNotMatch(walletless.container.textContent ?? "", /creator rights/i);
  await act(async () => walletless.container.remove());

  const down = await mountRights(t, { wallet: [COIN_FIXTURE.launchId], account: "down", capHeld: false }, { claims: fakeClaims().claims });
  assert.match(down.container.textContent ?? "", /Launchpad creator rights could not loadNothing changed: blast-infra could not answer \(unavailable\)\. Try again in a moment\./);
  assert.equal(rightsButtons().length, 1, "the wallet's launch is still offered");
  await act(async () => down.container.remove());

  for (const failing of ["account", "wallet"] as const) {
    let retried = 0;
    const retry = () => void (retried += 1);
    const failed = await mountRights(t, { wallet: [], account: [], capHeld: false }, failing === "account" ? { account: { status: "failed", retry } } : { wallet: { status: "failed", retry } });
    assert.match(failed.container.textContent ?? "", /Launchpad creator rights could not load/, failing);
    const button = [...failed.container.querySelectorAll("button")].find((candidate) => candidate.textContent === "Try again")!;
    await act(async () => button.click());
    assert.equal(retried, 1, failing);
    await act(async () => failed.container.remove());
  }
});

test("LP-17: a later page keeps the order rows arrived in, and only the busy Load more announces it", async (t) => {
  const LATER = `0x${"a4".repeat(32)}`;
  const { container } = await mountRights(t, { wallet: [COIN_FIXTURE.launchId], account: [ACCOUNT_LAUNCH], accountMore: [LATER], capHeld: false }, { claims: fakeClaims().claims });
  const shown = () => [...container.querySelectorAll<HTMLAnchorElement>('section[aria-labelledby="launch-creator-rights"] a[href^="/coin/"]')].map((link) => decodeURIComponent(link.getAttribute("href")!.slice("/coin/".length)));
  const before = shown();
  assert.deepEqual([...before].sort(), [ACCOUNT_LAUNCH, COIN_FIXTURE.launchId].map(claimCoinType).sort());
  const more = [...container.querySelectorAll("button")].find((button) => button.textContent === "Load more")!;
  await act(async () => more.click());
  for (let tick = 0; tick < 5; tick += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  assert.deepEqual(shown(), [...before, claimCoinType(LATER)], "the account's second page lands after the rows already shown");
  assert.equal(document.querySelectorAll('[role="status"][aria-label*="creator rights"]').length, 0);
});

test("LP-17: after a claim answers the server is read again, and the launch moves to the fee row only once blast-infra shows the cap", async (t) => {
  const signals = new Set<FreshnessSignal>();
  const before = globalThis.EventSource;
  globalThis.EventSource = class {} as unknown as typeof EventSource;
  t.after(() => { globalThis.EventSource = before; });
  t.mock.method(ActivityHints.prototype, "subscribe", (_name: string, next: FreshnessSignal) => {
    signals.add(next);
    return () => { signals.delete(next); };
  });
  const seen: string[] = [];
  const state: { wallet: readonly string[]; account: readonly string[]; capHeld: boolean } = { wallet: [COIN_FIXTURE.launchId], account: [], capHeld: false };
  const views = new Map<string, ClaimView>();
  const first = fakeClaims(views);
  const { render } = await mountRights(t, state, { claims: first.claims, seen });
  assert.equal(rightsButtons().length, 1);
  const reads = (part: string) => seen.filter((path) => path.includes(part)).length;
  const [claimsBefore, feesBefore] = [reads("/creator-claims?recipient="), reads(`/wallets/${WALLET}/launch-rewards`)];

  // Answered, but blast-infra has not indexed it yet: the row stays, nothing is guessed.
  views.set(`creator-caps:${COIN_FIXTURE.launchId}`, { state: "done", digest: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" });
  await render({ ...first.claims });
  assert.equal(reads("/creator-claims?recipient="), claimsBefore + 1);
  assert.equal(reads(`/wallets/${WALLET}/launch-rewards`), feesBefore + 1);
  assert.equal(document.querySelectorAll('button[data-claim="claim_launch_fees"]').length, 0);

  // blast-infra now shows the caps at the Blast wallet: the next read moves the launch.
  state.wallet = [];
  // The rights read can catch up before the separate fee read.
  state.capHeld = false;
  await act(async () => {
    signals.forEach((signal) => signal({ atMs: Date.now(), cause: "hint" }));
  });
  for (let tick = 0; tick < 5; tick += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  assert.equal(rightsButtons().length, 0);
  assert.doesNotMatch(document.body.textContent ?? "", /Launchpad creator rights/);
  assert.equal(document.querySelectorAll('button[data-claim="claim_launch_fees"]').length, 0);
  assert.equal(signals.size, 1, "fee watch survives the earlier rights inclusion");
  state.capHeld = true;
  await act(async () => signals.forEach((signal) => signal({ atMs: Date.now(), cause: "hint" })));
  for (let tick = 0; tick < 5; tick += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  assert.equal(document.querySelectorAll('button[data-claim="claim_launch_fees"]').length, 1);
  assert.equal(signals.size, 0, "indexed inclusion unsubscribes both rights and fee refreshes");
  const settledReads = seen.length;
  await act(async () => signals.forEach((signal) => signal({ atMs: Date.now(), cause: "hint" })));
  assert.equal(seen.length, settledReads, "unrelated activity makes no more settlement reads");
});

test("LP-17: a refusal is said once, by the host's toast; a launch claimed elsewhere leaves on the next read", async (t) => {
  const original = globalThis.EventSource;
  globalThis.EventSource = class {} as unknown as typeof EventSource;
  t.after(() => { globalThis.EventSource = original; });
  const subscribe = t.mock.method(ActivityHints.prototype, "subscribe", () => () => undefined);
  const state: { wallet: readonly string[]; account: readonly string[]; capHeld: boolean } = { wallet: [], account: [ACCOUNT_LAUNCH], capHeld: false };
  const views = new Map<string, ClaimView>();
  const first = fakeClaims(views);
  const { render, container } = await mountRights(t, state, { claims: first.claims });
  const { claimSettled } = await import("../claim/claims");
  state.account = [];
  views.set(`creator-caps:${ACCOUNT_LAUNCH}`, claimSettled({ status: "failed", code: "creator_caps_claimed" }));
  await render({ ...first.claims });
  assert.equal(rightsButtons().length, 0, "the read after the refusal no longer lists it");
  assert.doesNotMatch(container.textContent ?? "", /Launchpad creator rights/);

  const pending = fakeClaims(new Map([[`creator-caps:${COIN_FIXTURE.launchId}`, claimSettled({ status: "failed", code: "not_creator_recipient" })]]));
  const again = await mountRights(t, { wallet: [COIN_FIXTURE.launchId], account: [], capHeld: false }, { claims: pending.claims });
  assert.equal(again.container.querySelector('[role="alert"]'), null, "no inline copy beside the toast");
  assert.equal(rightsButtons().length, 1, "the claim stays offered");
  assert.equal(subscribe.mock.callCount(), 0, "refusals do one refresh and create no live settlement watch");
});

test("holder rewards failures stay local and offer recovery", async (t) => {
  const words = await mount("holder-refused", t);
  assert.match(words, /Froggy/);
  assert.match(words, /Couldn’t load holder rewards.*Try again/);
  assert.doesNotMatch(words, /No holder rewards yet/);
});
