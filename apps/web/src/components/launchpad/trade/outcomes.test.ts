import assert from "node:assert/strict";
import test from "node:test";

import { defineBlastDeployment } from "@interest-protocol/blast-sdk/deployments";
import type { ClientWithCoreApi } from "@mysten/sui/client";

import type { VerifiedOutcomeReport } from "#web/modules/launchpad-telemetry/client.ts";
import type { OutcomeReport } from "@blast/core/modules/launchpad-telemetry/contracts.ts";
import { outcomeTransactionResult, type OutcomeFixtureTransaction } from "../../../../../../packages/core/test/fixtures/modules/launchpad-telemetry/outcome-fixtures.ts";
import { createOutcomeVerifier } from "@blast/server/modules/launchpad-telemetry/outcomes.ts";
import type { ActionController, SignerSource } from "../transaction/controller.ts";
import { fixturePrivySigner, fixtureWalletSigner, NON_PRODUCTION_MANIFEST } from "../../../../test/fixtures/launchpad/transaction/fixtures.ts";
import type { LaunchpadSigner } from "../transaction/signer.ts";
import type { CurveTradeInput } from "./curve-adapter.ts";

import { createCurveTradeControllers, curveCompletionHandler, watchCurveTrades } from "./curve-trade-provider-model.ts";
import { tradeLedger, type CurveDiagnostic } from "./diagnostics.ts";
import { createTradeFixtureChain, TRADE_LAUNCH_ID, type TradeFixtureChain, type TradeFixtureState } from "../../../../../../packages/core/test/fixtures/launchpad/trade/trade-fixtures.ts";

const deployment = defineBlastDeployment(NON_PRODUCTION_MANIFEST);

const turn = () => new Promise((resolve) => setImmediate(resolve));

function rail({
  signer = fixtureWalletSigner(),
  fixture: overrides = {},
  commitOutcome = () => {},
}: Readonly<{
  signer?: LaunchpadSigner;
  fixture?: Partial<TradeFixtureState>;
  commitOutcome?: (outcome: OutcomeReport) => void;
}> = {}) {
  const fixture = createTradeFixtureChain(overrides);
  const signers: SignerSource = { kinds: [signer.kind], current: () => signer, connect: async () => signer };
  const chain = { client: fixture.client, manifest: NON_PRODUCTION_MANIFEST, mode: "non-production" as const };
  const controllers = createCurveTradeControllers({ chain, signers, launchId: TRADE_LAUNCH_ID, commitOutcome });
  return { fixture, signer, controllers };
}

/** One browser's trade ledger (its local storage). */
function browserStorage() {
  const values = new Map<string, string>();
  return () => ({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) });
}

/** What the provider does on each completion, for one page: diagnostics and the verified Buy outcome. */
function completionsOf(
  fixture: TradeFixtureChain,
  signer: LaunchpadSigner | (() => LaunchpadSigner | null),
  {
    storage = browserStorage(),
    reportOutcome = () => {},
    privyTokenTimeoutMs,
  }: Readonly<{ storage?: ReturnType<typeof browserStorage>; reportOutcome?: (outcome: VerifiedOutcomeReport) => void; privyTokenTimeoutMs?: number }> = {},
) {
  const diagnostics: CurveDiagnostic[] = [];
  const reads: string[] = [];
  const onCompleted = curveCompletionHandler({
    client: fixture.client,
    deployment,
    launchId: TRADE_LAUNCH_ID,
    ledger: tradeLedger(storage),
    decimals: () => 9,
    signer: typeof signer === "function" ? signer : () => signer,
    reportOutcome,
    ...(privyTokenTimeoutMs === undefined ? {} : { privyTokenTimeoutMs }),
    onRead: (digest) => void reads.push(digest),
  });
  return { diagnostics, reads, onCompleted };
}

async function until(controller: ActionController<CurveTradeInput>, phases: readonly string[]) {
  for (let count = 0; count < 300 && !phases.includes(controller.getState().phase); count += 1) await turn();
  return controller.getState();
}

/** Reviews and signs one trade of `amount`; returns its final state. */
async function trade(controller: ActionController<CurveTradeInput>, amount: string) {
  controller.edit({ ...controller.getState().input, amount });
  controller.submit();
  const review = await until(controller, ["review", "blocked"]);
  assert.equal(review.phase, "review", JSON.stringify(review.phase === "blocked" ? review.block : review.phase));
  if (review.phase === "review") controller.approve(review.review.id);
  return until(controller, ["succeeded", "failed", "rejected", "ambiguous"]);
}

test("a signed Buy commits its digest and launch as this browser's own before it is submitted; a Sale commits nothing", async () => {
  const commits: { outcome: OutcomeReport; executed: number }[] = [];
  const { fixture, signer, controllers } = rail({
    commitOutcome: (outcome) => void commits.push({ outcome, executed: fixture.calls.execute }),
  });
  const bought = await trade(controllers.buy, "10");
  assert.equal(bought.phase, "succeeded");
  const digest = bought.phase === "succeeded" ? bought.digest : "";
  assert.deepEqual(commits, [{ outcome: { kind: "buy", launchId: TRADE_LAUNCH_ID, txDigest: digest }, executed: 0 }]);

  fixture.state.meme[signer.address] = 5_000_000_000_000_000n;
  assert.equal((await trade(controllers.sell, "1000")).phase, "succeeded");
  assert.equal(commits.length, 1, "a Sale is never committed");
});

test("a declined or refused Buy commits nothing, and a commitment that throws leaves the Buy unchanged", async () => {
  let commits = 0;
  const declined = rail({ signer: fixtureWalletSigner({ decide: () => "reject" }), commitOutcome: () => void (commits += 1) });
  assert.equal((await trade(declined.controllers.buy, "10")).phase, "rejected");
  const refused = rail({ fixture: { execution: "abort" }, commitOutcome: () => void (commits += 1) });
  assert.equal((await trade(refused.controllers.buy, "10")).phase, "failed");
  assert.equal(commits, 1, "only the signed Buy that was submitted (and then aborted on chain) committed");

  const failing = rail({
    commitOutcome: () => {
      throw new Error("the commitments route is down");
    },
  });
  const done = await trade(failing.controllers.buy, "10");
  assert.equal(done.phase, "succeeded");
  assert.equal(failing.fixture.calls.execute, 1);
});

test("a completed Buy is reported once per digest to the verified-outcome route, and a reopened page does not report it again", async () => {
  const storage = browserStorage();
  const reports: VerifiedOutcomeReport[] = [];
  const { fixture, signer, controllers } = rail();
  const page = completionsOf(fixture, signer, { storage, reportOutcome: (outcome) => void reports.push(outcome) });
  const stop = watchCurveTrades(controllers, {
    deployment,
    report: (diagnostic) => void page.diagnostics.push(diagnostic),
    refresh: () => {},
    onCompleted: page.onCompleted,
  });
  const bought = await trade(controllers.buy, "10");
  assert.equal(bought.phase, "succeeded");
  if (bought.phase !== "succeeded") return;
  for (let count = 0; count < 100 && page.reads.length === 0; count += 1) await turn();
  assert.deepEqual(reports, [{ kind: "buy", launchId: TRADE_LAUNCH_ID, txDigest: bought.digest }]);
  // The client diagnostics stay as they were: diagnostics, reported alongside.
  assert.deepEqual(
    page.diagnostics.filter((entry) => entry.event === "curve_completed" || entry.event === "curve_conversion").map((entry) => entry.event),
    ["curve_completed", "curve_conversion"],
  );
  stop();

  // The same completion handed to the page again, and to a reopened page in the same browser.
  page.onCompleted("buy", bought, 1_000, () => {});
  const reopened = completionsOf(fixture, signer, { storage, reportOutcome: (outcome) => void reports.push(outcome) });
  reopened.onCompleted("buy", bought, 1_000, () => {});
  for (let count = 0; count < 100 && (page.reads.length < 2 || reopened.reads.length === 0); count += 1) await turn();
  assert.equal(reports.length, 1);
});

test("a completed Sale, a declined or failed Buy, and a completion without a Bought never report", async () => {
  const reports: VerifiedOutcomeReport[] = [];
  const reportOutcome = (outcome: VerifiedOutcomeReport) => void reports.push(outcome);
  const follow = (setup: ReturnType<typeof rail>) => {
    const page = completionsOf(setup.fixture, setup.signer, { reportOutcome });
    const stop = watchCurveTrades(setup.controllers, { deployment, report: () => {}, refresh: () => {}, onCompleted: page.onCompleted });
    return { page, stop };
  };

  const selling = rail();
  selling.fixture.state.meme[selling.signer.address] = 5_000_000_000_000_000n;
  const sale = follow(selling);
  const sold = await trade(selling.controllers.sell, "1000");
  assert.equal(sold.phase, "succeeded");
  for (let count = 0; count < 100 && sale.page.reads.length === 0; count += 1) await turn();
  assert.equal(sale.page.reads.length, 1, "the Sale's completed event was read");
  // The same Sale handed on as if it were a Buy: its completed event is not a `Bought`.
  if (sold.phase === "succeeded") sale.page.onCompleted("buy", sold, 0, () => {});
  for (let count = 0; count < 100 && sale.page.reads.length < 2; count += 1) await turn();
  sale.stop();

  const declined = rail({ signer: fixtureWalletSigner({ decide: () => "reject" }) });
  const decline = follow(declined);
  assert.equal((await trade(declined.controllers.buy, "10")).phase, "rejected");
  decline.stop();

  const aborted = rail({ fixture: { execution: "abort" } });
  const abort = follow(aborted);
  assert.equal((await trade(aborted.controllers.buy, "10")).phase, "failed");
  abort.stop();

  const lost = rail({ fixture: { execution: "unknown" } });
  const unknown = follow(lost);
  assert.equal((await trade(lost.controllers.buy, "10")).phase, "ambiguous");
  for (let count = 0; count < 50; count += 1) await turn();
  unknown.stop();

  assert.deepEqual(reports, []);
  assert.deepEqual([...decline.page.reads, ...abort.page.reads, ...unknown.page.reads], [], "no completion was handed on");
});

/** A completed Buy signed by `signer`, handed to a fresh page whose connected signer is `current`. */
async function reportedFor(signer: LaunchpadSigner, current: () => LaunchpadSigner | null = () => signer, privyTokenTimeoutMs = 20) {
  const reports: { outcome: VerifiedOutcomeReport; atMs: number }[] = [];
  // Reporting tests use local execution; sponsored submission is covered in curve-sponsorship.test.ts.
  const { fixture, controllers } = rail({ signer: { ...signer, kind: "wallet" } });
  const bought = await trade(controllers.buy, "10");
  assert.equal(bought.phase, "succeeded");
  if (bought.phase !== "succeeded") return assert.fail();
  const page = completionsOf(fixture, current, {
    privyTokenTimeoutMs,
    reportOutcome: (outcome) => void reports.push({ outcome, atMs: Date.now() }),
  });
  const startedMs = Date.now();
  const completed = { ...bought, review: { ...bought.review, signer: { ...bought.review.signer, kind: signer.kind } } };
  page.onCompleted("buy", completed, 0, () => {});
  for (let count = 0; count < 200 && reports.length === 0; count += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(reports.length, 1);
  return { digest: bought.digest, outcome: reports[0]!.outcome, waitedMs: reports[0]!.atMs - startedMs };
}

test("a Privy Buy's report carries its Privy session; a stalled or failing session read sends the report without it by the deadline", async () => {
  const privy = (accessToken: () => Promise<string | null>) => ({ ...fixturePrivySigner(), accessToken });
  const session = await reportedFor(privy(async () => "privy.session.token"));
  assert.deepEqual(session.outcome, { kind: "buy", launchId: TRADE_LAUNCH_ID, txDigest: session.digest, privyToken: "privy.session.token" });

  const stalled = await reportedFor(privy(() => new Promise(() => {})), undefined, 40);
  assert.deepEqual(stalled.outcome, { kind: "buy", launchId: TRADE_LAUNCH_ID, txDigest: stalled.digest });
  assert.ok(stalled.waitedMs >= 35, `the report waited ${stalled.waitedMs} ms for the token, at most the deadline`);

  for (const accessToken of [async () => null, () => Promise.reject(new Error("Privy is down"))]) {
    const without = await reportedFor(privy(accessToken), undefined, 5_000);
    assert.deepEqual(without.outcome, { kind: "buy", launchId: TRADE_LAUNCH_ID, txDigest: without.digest });
    assert.ok(without.waitedMs < 1_000, "a session that answers no token is not waited for");
  }

  // Only the Privy session that signed: a direct wallet has none, and a session now on another wallet is not sent.
  const signed = privy(async () => "privy.session.token");
  const other = { ...signed, address: fixtureWalletSigner().address };
  for (const [signer, current] of [
    [fixtureWalletSigner(), () => fixtureWalletSigner()],
    [signed, () => other],
    [signed, () => null],
  ] as const) {
    const report = await reportedFor(signer, current);
    assert.equal("privyToken" in report.outcome, false);
  }
});

test("an outcome report that throws never changes the trade, its refresh, its diagnostics, or later trades", async () => {
  let attempts = 0;
  const { fixture, signer, controllers } = rail();
  const page = completionsOf(fixture, signer, {
    reportOutcome: () => {
      attempts += 1;
      throw new Error("the outcomes route is down");
    },
  });
  const refreshed: (readonly string[])[] = [];
  const stopRefresh = controllers.buy.onInvalidate((keys) => void refreshed.push(keys));
  const stop = watchCurveTrades(controllers, {
    deployment,
    report: (diagnostic) => void page.diagnostics.push(diagnostic),
    refresh: () => {},
    onCompleted: page.onCompleted,
  });
  const first = await trade(controllers.buy, "10");
  for (let count = 0; count < 100 && page.reads.length < 1; count += 1) await turn();
  controllers.buy.acknowledge();
  const second = await trade(controllers.buy, "20");
  for (let count = 0; count < 100 && page.reads.length < 2; count += 1) await turn();
  stop();
  stopRefresh();
  assert.deepEqual([first.phase, second.phase], ["succeeded", "succeeded"]);
  assert.notEqual(first.phase === "succeeded" && first.digest, second.phase === "succeeded" && second.digest);
  assert.equal(attempts, 2, "each completed Buy was offered to the reporter once");
  assert.equal(refreshed.length, 2, "each completed Buy refreshed its reads");
  assert.equal(page.diagnostics.filter((entry) => entry.event === "curve_conversion").length, 2);
});

test("the dev harness's landed Buy verifies as a buy of its launch for the wallet that signed it; its Sale does not", async () => {
  const signer = fixtureWalletSigner();
  const { fixture, controllers } = rail({ signer });
  const bought = await trade(controllers.buy, "10");
  fixture.state.meme[signer.address] = 5_000_000_000_000_000n;
  const sold = await trade(controllers.sell, "1000");
  const digestOf = (state: typeof bought) => (state.phase === "succeeded" ? state.digest : assert.fail(state.phase));
  // The dev node holds what the harness lands: the browser fixture's transaction, checkpointed when it lands.
  const node = new Map<string, OutcomeFixtureTransaction>();
  for (const digest of [digestOf(bought), digestOf(sold)]) {
    const landed = fixture.transactionOf(digest);
    assert.ok(landed, "a completed transaction can be landed");
    node.set(digest, { ...landed, timestampMs: 1_790_000_200_000 });
  }
  const client = {
    core: {
      getChainIdentifier: async () => ({ chainIdentifier: NON_PRODUCTION_MANIFEST.chainIdentifier }),
      getTransaction: async ({ digest }: Readonly<{ digest: string }>) => outcomeTransactionResult(node.get(digest)!),
    },
  } as unknown as ClientWithCoreApi;
  const verify = createOutcomeVerifier(async () => ({ client, manifest: NON_PRODUCTION_MANIFEST }));
  const verdict = await verify({ kind: "buy", launchId: TRADE_LAUNCH_ID, txDigest: digestOf(bought) });
  assert.equal(verdict.status, "verified");
  assert.equal(verdict.status === "verified" && verdict.senderWallet, signer.address);
  assert.equal(verdict.status === "verified" && verdict.completion.eventSeq, 0);
  assert.deepEqual(await verify({ kind: "buy", launchId: TRADE_LAUNCH_ID, txDigest: digestOf(sold) }), { status: "refused", reason: "not-a-buy" });
  assert.equal(fixture.transactionOf("UnknownDigest1111111111111111111111111111111"), null);
});
