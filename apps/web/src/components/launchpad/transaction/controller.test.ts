import assert from "node:assert/strict";
import test from "node:test";

import type { ActionPhase, SignerKind } from "./action-machine.ts";
import { createActionController, type SignerSource } from "./controller.ts";
import {
  createFixtureChain,
  fixtureBuyAdapter,
  fixturePrivySigner,
  fixtureWalletSigner,
  FIXTURE_LAUNCH_ID,
  NON_PRODUCTION_MANIFEST,
  type FixtureChainState,
  type FixtureSignerBehavior,
} from "../../../../test/fixtures/launchpad/transaction/fixtures.ts";
import type { LaunchpadSigner } from "./signer.ts";
import { freshTrade } from "../trade/amount.ts";

const IN_FLIGHT: ReadonlySet<ActionPhase> = new Set(["connecting", "preflighting", "signing", "reconciling"]);

type Harness = ReturnType<typeof harness>;

type FixtureInput = Readonly<{ launchId: string; amount: string }>;

function harness(
  overrides: Partial<FixtureChainState> = {},
  options: Readonly<{
    decide?: FixtureSignerBehavior["decide"];
    walletChains?: readonly string[];
    delayedCurrent?: boolean;
    expiresAtMs?: number;
    onSigned?: (signed: Readonly<{ digest: string; input: FixtureInput }>) => void;
    restart?: (input: FixtureInput) => FixtureInput;
    adapter?: typeof fixtureBuyAdapter;
  }> = {},
) {
  const fixture = createFixtureChain(overrides);
  const counts = { connect: [] as SignerKind[], signatures: 0, invalidated: [] as (readonly string[])[], checkpoints: [] as (number | null)[] };
  const behavior: FixtureSignerBehavior = { decide: options.decide, onRequest: () => (counts.signatures += 1) };
  let connected: LaunchpadSigner | null = null;
  const wallet = { chains: options.walletChains ?? ["sui:mainnet"] };
  const signers: SignerSource = {
    kinds: ["privy", "wallet"],
    current: () =>
      options.delayedCurrent ? null : connected?.kind === "wallet" ? fixtureWalletSigner(behavior, wallet.chains) : connected,
    async connect(kind) {
      counts.connect.push(kind);
      connected = kind === "privy" ? fixturePrivySigner(behavior) : fixtureWalletSigner(behavior, wallet.chains);
      return connected;
    },
  };
  let reviews = 0;
  const controller = createActionController({
    adapter: options.adapter ?? (options.expiresAtMs === undefined ? fixtureBuyAdapter : { ...fixtureBuyAdapter, expiresAtMs: () => options.expiresAtMs }),
    chain: { client: fixture.client, manifest: NON_PRODUCTION_MANIFEST, mode: "non-production" },
    signers,
    input: { launchId: FIXTURE_LAUNCH_ID, amount: "12.5" },
    newReviewId: () => `review-${(reviews += 1)}`,
    ...(options.onSigned ? { onSigned: options.onSigned } : {}),
    ...(options.restart ? { restart: options.restart } : {}),
  });
  controller.onInvalidate((keys, checkpoint) => { counts.invalidated.push(keys); counts.checkpoints.push(checkpoint); });
  return { fixture, counts, controller, wallet, disconnect: () => { connected = null; } };
}

async function settle({ controller }: Harness) {
  for (let turn = 0; turn < 200; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (!IN_FLIGHT.has(controller.getState().phase)) return controller.getState();
  }
  throw new Error(`still ${controller.getState().phase}`);
}

async function reviewWith(h: Harness, kind: SignerKind = "wallet") {
  h.controller.submit();
  h.controller.chooseSigner(kind);
  const state = await settle(h);
  assert.equal(state.phase, "review", JSON.stringify(state.phase === "blocked" ? state.block : state.phase));
  return state.phase === "review" ? state.review : assert.fail();
}

async function approve(h: Harness) {
  const state = h.controller.getState();
  assert.equal(state.phase, "review");
  if (state.phase === "review") h.controller.approve(state.review.id);
  return settle(h);
}

test("no signer connects until the user submits and picks one", async () => {
  const h = harness();
  h.controller.edit({ launchId: FIXTURE_LAUNCH_ID, amount: "20" });
  assert.deepEqual(h.counts.connect, []);
  h.controller.submit();
  assert.equal(h.controller.getState().phase, "choosing-signer");
  assert.deepEqual(h.counts.connect, [], "submitting alone connects nothing");
  h.controller.chooseSigner("privy");
  await settle(h);
  assert.deepEqual(h.counts.connect, ["privy"]);
  assert.equal(h.controller.getState().phase, "review");
  assert.deepEqual(h.controller.getState().input, { launchId: FIXTURE_LAUNCH_ID, amount: "20" });
});

test("both signer kinds complete with one signature, canonical evidence, and read invalidation", async () => {
  for (const kind of ["privy", "wallet"] as const) {
    const h = harness();
    await reviewWith(h, kind);
    const done = await approve(h);
    assert.equal(done.phase, "succeeded", kind);
    assert.equal(h.counts.signatures, 1);
    assert.equal(h.fixture.calls.execute, 1);
    assert.match(done.phase === "succeeded" ? (done.explorerUrl ?? "") : "", /^http:\/\/127\.0\.0\.1:9001\/tx\/\w+$/);
    assert.deepEqual(h.counts.invalidated, [[`launch:${FIXTURE_LAUNCH_ID}`, "wallet:balances"]]);
    assert.deepEqual(h.counts.checkpoints, [41], "the trade's checkpoint, which the coin's price must include");
  }
});

test("the optional onSigned hook hears the signed digest and input after the signature and before the submission", async () => {
  const seen: { digest: string; input: unknown; executed: number }[] = [];
  const h = harness({}, { onSigned: ({ digest, input }) => void seen.push({ digest, input, executed: h.fixture.calls.execute }) });
  await reviewWith(h, "privy");
  const done = await approve(h);
  assert.equal(done.phase, "succeeded");
  assert.deepEqual(seen, [
    { digest: done.phase === "succeeded" ? done.digest : "", input: { launchId: FIXTURE_LAUNCH_ID, amount: "12.5" }, executed: 0 },
  ]);
});

test("the onSigned hook never holds back or changes the submission, and a declined signature never reaches it", async () => {
  const throwing = harness({}, {
    onSigned: () => {
      throw new Error("telemetry down");
    },
  });
  await reviewWith(throwing);
  assert.equal((await approve(throwing)).phase, "succeeded", "a throwing hook still submits");
  assert.equal(throwing.fixture.calls.execute, 1);

  const stalled = harness({}, { onSigned: () => new Promise<void>(() => {}) as unknown as void });
  await reviewWith(stalled);
  assert.equal((await approve(stalled)).phase, "succeeded", "a hook that never settles is not awaited");
  assert.equal(stalled.fixture.calls.execute, 1);

  let heard = 0;
  const declined = harness({}, { decide: () => "reject", onSigned: () => void (heard += 1) });
  await reviewWith(declined);
  assert.equal((await approve(declined)).phase, "rejected");
  assert.equal(heard, 0);
});

test("a material change before approval replaces the review without asking for a signature", async () => {
  const h = harness();
  const first = await reviewWith(h);
  // Another buyer moves the curve after the review was shown.
  const launch = h.fixture.state.launch!;
  launch.curve = { ...launch.curve, realQuoteReserve: launch.curve.realQuoteReserve + 2_000_000_000_000n };
  const changed = await approve(h);
  assert.equal(changed.phase, "review");
  if (changed.phase !== "review") return;
  assert.notEqual(changed.review.id, first.id);
  assert.deepEqual(changed.changes.map((change) => change.key), ["meme-out"]);
  assert.equal(h.counts.signatures, 0);
  const done = await approve(h);
  assert.equal(done.phase, "succeeded");
  assert.equal(h.counts.signatures, 1);
});

test("a wrong-network wallet stays blocked until it is corrected and reviewed again", async () => {
  const h = harness({}, { walletChains: ["sui:testnet"] });
  h.controller.submit();
  h.controller.chooseSigner("wallet");
  const blocked = await settle(h);
  assert.equal(blocked.phase === "blocked" && blocked.block.code, "wrong-network");
  h.controller.submit();
  assert.equal((await settle(h)).phase, "blocked", "still wrong");
  h.wallet.chains = ["sui:mainnet"];
  h.controller.submit();
  assert.equal((await settle(h)).phase, "review");
  assert.deepEqual(h.counts.connect, ["wallet"], "reviewing again reuses the connected wallet");
  assert.equal(h.counts.signatures, 0);
});

test("a declined signature is kept, never retried, and a new attempt needs a new approval", async () => {
  let decision: "sign" | "reject" = "reject";
  const h = harness({}, { decide: () => decision });
  await reviewWith(h);
  const rejected = await approve(h);
  assert.equal(rejected.phase, "rejected");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.controller.getState().phase, "rejected");
  assert.equal(h.counts.signatures, 1);
  assert.equal(h.fixture.calls.execute, 0);
  decision = "sign";
  h.controller.submit();
  assert.equal((await settle(h)).phase, "review");
  assert.equal(h.counts.signatures, 1, "reviewing again asks for nothing");
  assert.equal((await approve(h)).phase, "succeeded");
  assert.equal(h.counts.signatures, 2);
});

test("#1012: a success empties the amount at once; a declined signature keeps the entry", async () => {
  let decision: "sign" | "reject" = "reject";
  const h = harness({}, { decide: () => decision, restart: freshTrade });
  await reviewWith(h);
  assert.equal((await approve(h)).phase, "rejected");
  h.controller.acknowledge();
  assert.deepEqual(h.controller.getState().input, { launchId: FIXTURE_LAUNCH_ID, amount: "12.5" }, "a declined trade is retried as entered");
  decision = "sign";
  await reviewWith(h);
  const done = await approve(h);
  assert.equal(done.phase, "succeeded");
  assert.deepEqual(done.input, { launchId: FIXTURE_LAUNCH_ID, amount: "" }, "the finished amount is not left in the box");
  h.controller.edit({ ...done.input, amount: "1200" });
  const next = h.controller.getState();
  assert.equal(next.phase, "editing", "typing after a success starts the next trade");
  assert.equal(next.input.amount, "1200");
});

test("a success reached by rechecking a lost answer also empties the amount, after invalidating with the traded one", async () => {
  const invalidatedFor: string[] = [];
  const adapter = { ...fixtureBuyAdapter, affectedReads: (input: FixtureInput) => (invalidatedFor.push(input.amount), fixtureBuyAdapter.affectedReads(input)) };
  const h = harness({ execution: "unknown" }, { restart: freshTrade, adapter });
  await reviewWith(h);
  assert.equal((await approve(h)).phase, "ambiguous");
  h.controller.recheck();
  const done = await settle(h);
  assert.equal(done.phase, "succeeded");
  assert.equal(done.input.amount, "");
  assert.deepEqual(invalidatedFor, ["12.5"]);
});

test("without restart, acknowledging a success keeps the last input", async () => {
  const h = harness();
  await reviewWith(h);
  assert.equal((await approve(h)).phase, "succeeded");
  h.controller.acknowledge();
  assert.deepEqual(h.controller.getState().input, { launchId: FIXTURE_LAUNCH_ID, amount: "12.5" });
});

test("an ambiguous submission is only ever reconciled by digest", async () => {
  const h = harness({ execution: "unknown" });
  await reviewWith(h);
  const ambiguous = await approve(h);
  assert.equal(ambiguous.phase, "ambiguous");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.controller.getState().phase, "ambiguous", "no automatic resubmission");
  assert.equal(h.fixture.calls.execute, 1);
  h.controller.submit();
  assert.equal(h.controller.getState().phase, "ambiguous", "a new submission is refused");
  h.controller.recheck();
  const done = await settle(h);
  assert.equal(done.phase, "succeeded");
  assert.equal(h.fixture.calls.execute, 1);
  assert.equal(h.counts.signatures, 1);
});

test("repeated approval clicks request one signature", async () => {
  const h = harness();
  const review = await reviewWith(h);
  h.controller.approve(review.id);
  h.controller.approve(review.id);
  assert.equal((await settle(h)).phase, "succeeded");
  assert.equal(h.counts.signatures, 1);
  assert.equal(h.fixture.calls.execute, 1);
});

test("an on-chain failure keeps the entry and still refreshes affected reads", async () => {
  const h = harness({ execution: "abort" });
  await reviewWith(h);
  const failed = await approve(h);
  assert.equal(failed.phase, "failed");
  assert.deepEqual(failed.input, { launchId: FIXTURE_LAUNCH_ID, amount: "12.5" });
  assert.equal(h.counts.invalidated.length, 1);
  assert.deepEqual(h.counts.checkpoints, [null]);
});

test("the whole flow makes no Blast Account or backend request", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("unexpected network call");
  }) as typeof fetch;
  try {
    const h = harness();
    await reviewWith(h, "privy");
    assert.equal((await approve(h)).phase, "succeeded");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 0);
});


test("disconnecting after review cannot sign with the previously connected wallet", async () => {
  const h = harness();
  await reviewWith(h);
  h.disconnect();
  const state = await approve(h);
  assert.equal(state.phase, "blocked");
  assert.equal(state.phase === "blocked" && state.block.code, "signer-unavailable");
  assert.equal(h.counts.signatures, 0);
  assert.equal(h.fixture.calls.execute, 0);
});


test("the initial unsigned review accepts a connection before React publishes the current account", async () => {
  const h = harness({}, { delayedCurrent: true });
  await reviewWith(h);
  assert.equal(h.counts.signatures, 0);
  const state = await approve(h);
  assert.equal(state.phase, "blocked", "approval still requires the current account");
  assert.equal(h.counts.signatures, 0);
});


test("a quote expiring during approval simulation never reaches the signing wallet", async (t) => {
  const start = Date.now();
  let now = start;
  t.mock.method(Date, "now", () => now);
  const h = harness({}, { expiresAtMs: start + 20_000 });
  await reviewWith(h);
  const simulate = h.fixture.client.core.simulateTransaction.bind(h.fixture.client.core);
  t.mock.method(h.fixture.client.core, "simulateTransaction", async (...args: Parameters<typeof simulate>) => {
    const result = await simulate(...args);
    now = start + 21_000;
    return result;
  });
  const state = await approve(h);
  assert.equal(state.phase, "failed");
  assert.match(state.phase === "failed" ? state.message : "", /quote expired/);
  assert.equal(h.counts.signatures, 0);
  assert.equal(h.fixture.calls.execute, 0);
});


test("wallet confirmation runs fresh preflight then signs once without a second review", async () => {
  const h = harness();
  h.controller.submit({ confirmInWallet: true });
  h.controller.chooseSigner("privy");
  const done = await settle(h);
  assert.equal(done.phase, "succeeded");
  assert.equal(h.counts.signatures, 1);
  assert.equal(h.fixture.calls.execute, 1);
});


test("wallet-confirmed submits still block wrong networks, reject once and reconcile unknown sends", async () => {
  for (const [overrides, options, expected, signatures, executions] of [
    [{}, { walletChains: ["sui:testnet"] }, "blocked", 0, 0],
    [{}, { decide: () => "reject" as const }, "rejected", 1, 0],
    [{ execution: "unknown" as const }, {}, "ambiguous", 1, 1],
  ] as const) {
    const h = harness(overrides, options);
    h.controller.submit({ confirmInWallet: true });
    h.controller.chooseSigner("wallet");
    assert.equal((await settle(h)).phase, expected);
    assert.equal(h.counts.signatures, signatures);
    assert.equal(h.fixture.calls.execute, executions);
    if (expected === "ambiguous") {
      h.controller.submit({ confirmInWallet: true });
      assert.equal(h.controller.getState().phase, "ambiguous");
      h.controller.recheck();
      assert.equal((await settle(h)).phase, "succeeded");
      assert.equal(h.fixture.calls.execute, 1);
    }
  }
});

test("wallet-confirmed repeated clicks and an expired simulation never sign twice", async (t) => {
  const h = harness();
  h.controller.submit({ confirmInWallet: true });
  h.controller.chooseSigner("privy");
  h.controller.submit({ confirmInWallet: true });
  assert.equal((await settle(h)).phase, "succeeded");
  assert.equal(h.counts.signatures, 1);
  assert.equal(h.fixture.calls.execute, 1);

  const start = Date.now();
  let now = start;
  t.mock.method(Date, "now", () => now);
  const expired = harness({}, { expiresAtMs: start + 20_000 });
  const simulate = expired.fixture.client.core.simulateTransaction.bind(expired.fixture.client.core);
  t.mock.method(expired.fixture.client.core, "simulateTransaction", async (...args: Parameters<typeof simulate>) => {
    const result = await simulate(...args);
    now = start + 21_000;
    return result;
  });
  expired.controller.submit({ confirmInWallet: true });
  expired.controller.chooseSigner("privy");
  assert.equal((await settle(expired)).phase, "failed");
  assert.equal(expired.counts.signatures, 0);
  assert.equal(expired.fixture.calls.execute, 0);
});
