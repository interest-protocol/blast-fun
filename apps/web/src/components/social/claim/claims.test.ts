import assert from "node:assert/strict";
import test from "node:test";

import {
  CLAIM_UNREACHABLE,
  CLAIMING,
  claimButtonText,
  claimCanRetry,
  claimPathSupports,
  claimRefusalCopy,
  claimRefusalDescription,
  claimSettled,
  failureShort,
  LOGGED_CLAIM_FAILURES,
  LOGGED_FAILURES,
  publishedClaimCode,
  saleClaimTarget,
  type ClaimOutcome,
  type ClaimPath,
  type ClaimTarget,
  type ClaimView,
} from "./claims";
import { createClaimRunner } from "./claim-runner";

test("a token claim toast names the indexed amount and where it went", () => {
  const target = saleClaimTarget("claim_tokens", { presale_id: "0xlake", name: "Lake", symbol: "LAKE", quote_symbol: "SUI" }, "0 SUI", "440,000,000 LAKE");
  assert.equal(target.done.title, "Claimed 440,000,000 LAKE");
  assert.equal(target.done.sub, "Lake · now in your wallet");
});

test("a vested presale claim starts escrow and keeps the action labels accurate", () => {
  const target = saleClaimTarget("claim_tokens", { presale_id: "0xlake", name: "Lake", symbol: "LAKE", quote_symbol: "SUI" }, "0 SUI", "440,000,000 LAKE", true);
  assert.equal(target.done.title, "Your buyer vesting has started");
  assert.equal(target.done.sub, "Lake · tokens in your vesting schedule");
  assert.equal(claimButtonText({ state: "claiming" }, "Start your vesting", "claim_tokens"), "Starting vesting");
  assert.equal(claimButtonText({ state: "done", digest: "d" }, "Start your vesting", "claim_tokens"), "Vesting started");
  assert.equal(claimButtonText({ state: "failed", code: "rejected", message: "" }, "Start your vesting", "claim_tokens"), "Start your vesting");
});

/**
 * R3-58-AC-7's rules (§22.1 defects 2 and 3): a claim that fails says so with
 * a published code and the shared copy, never a raw chain string and never
 * silence; and a claim that runs says `Claiming`, never a bare spinner.
 */

test("every published failure the log can hold has its own refusal copy and its own short reason", () => {
  const fallback = claimRefusalCopy("something_new");
  const copies = LOGGED_CLAIM_FAILURES.map((code) => claimRefusalCopy(code));
  assert.equal(new Set(copies).size, LOGGED_CLAIM_FAILURES.length, "one line per code");
  assert.ok(copies.every((copy) => copy !== fallback && copy.length > 0));
  assert.equal(claimRefusalCopy("rejected"), "You declined it in your wallet. Nothing was claimed. Code: rejected.");
  assert.equal(claimRefusalCopy("execution_failed"), "The claim failed on Sui. Nothing moved. Code: execution_failed.");
  assert.equal(fallback, "The claim didn't go through. Nothing was claimed. Code: request_failed.");
  const reasons = LOGGED_CLAIM_FAILURES.map((code) => failureShort(code));
  assert.equal(new Set(reasons).size, LOGGED_CLAIM_FAILURES.length);
  assert.equal(failureShort(null), "it didn't go through");
});

test("every failure the session list can show, a trade's (R3-31) included, has its own short reason", () => {
  const reasons = LOGGED_FAILURES.map((code) => failureShort(code));
  assert.equal(new Set(reasons).size, LOGGED_FAILURES.length);
  assert.ok(reasons.every((reason) => reason !== failureShort(null)));
  assert.equal(failureShort("price_moved"), "the price moved");
  assert.equal(failureShort("sponsor_refused"), "sponsorship was refused");
  assert.equal(claimRefusalDescription("sponsor_refused"), "Blast couldn't sponsor this transaction. Nothing was sent.");
  assert.ok(!LOGGED_CLAIM_FAILURES.includes("price_moved"), "a claim never logs a trade's failure");
});

test("a raw chain error, an empty code or a thrown path is shown under its own published code, never repeated", () => {
  assert.equal(publishedClaimCode("MoveAbort(MoveLocation { module: ModuleId { address: 76cb } }, 7)"), CLAIM_UNREACHABLE);
  assert.equal(publishedClaimCode(""), CLAIM_UNREACHABLE);
  assert.equal(publishedClaimCode(undefined), CLAIM_UNREACHABLE);
  assert.equal(publishedClaimCode("rate_limited"), "rate_limited");
  assert.deepEqual(claimSettled(null), {
    state: "failed",
    code: CLAIM_UNREACHABLE,
    message: "The claim couldn't reach Blast. Nothing was claimed. Try again. Code: claim_unreachable.",
  });
  assert.deepEqual(claimSettled({ status: "failed", code: "MoveAbort(…) in command 0" }).state, "failed");
  assert.deepEqual(claimSettled({ status: "failed", code: "dry_run_failed" }), {
    state: "failed",
    code: "dry_run_failed",
    message: "This claim would fail on Sui. Nothing was claimed. Code: dry_run_failed.",
  });
  const digest = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
  assert.deepEqual(claimSettled({ status: "failed", code: "claim_pending", digest, requestId: "claim-ref-1" }), {
    state: "failed",
    code: "claim_pending",
    digest,
    message: `Your claim is awaiting confirmation. Check ${digest} on Sui before claiming again. Code: claim_pending. Reference: claim-ref-1.`,
  });
  assert.deepEqual(claimSettled({ status: "confirmed", digest: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi" }), {
    state: "done",
    digest: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
  });
});

test("defect 3: the busy button names what it is doing, the vesting claim's included", () => {
  assert.equal(CLAIMING, "Claiming");
  assert.equal(claimButtonText({ state: "claiming" }, "Claim 31,111 LUMN"), "Claiming");
  assert.equal(claimButtonText({ state: "idle" }, "Claim $250"), "Claim $250");
  assert.equal(claimButtonText({ state: "failed", code: "rejected", message: "" }, "Claim $250"), "Claim $250", "a refusal leaves the button ready to try again");
});

/* ---------------- the runner every claim button shares ---------------- */

const REFUND: ClaimTarget = {
  key: "refund:0xh",
  kind: "claim_refund",
  presaleId: "0xh",
  done: { title: "$250 refund claimed", sub: "From Halcyon, now in your USDC" },
};

function deferred() {
  let resolve!: (outcome: ClaimOutcome) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<ClaimOutcome>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("toast recovery uses plain copy and never offers retry for unresolved or unavailable claims", () => {
  assert.equal(claimRefusalDescription("rejected"), "You declined it in your wallet. Nothing was claimed.");
  for (const code of ["rejected", "claim_unreachable", "expired", "sign_failed"]) {
    assert.equal(claimCanRetry(claimSettled({ status: "failed", code })), true);
    assert.doesNotMatch(claimRefusalDescription(code), /Code:|Reference:/);
    assert.equal(claimCanRetry(claimSettled({ status: "failed", code, digest: "sent" })), false);
  }
  for (const code of ["claim_pending", "nothing_to_claim", "already_claimed", "claim_not_open", "account_required"]) {
    assert.equal(claimCanRetry(claimSettled({ status: "failed", code })), false);
  }
});

test("the toast retry shares the runner's duplicate, completion and disposal guards", async () => {
  const answers = [deferred(), deferred()];
  let calls = 0;
  let retry: (() => void) | undefined;
  const runner = createClaimRunner(() => answers[calls++]!.promise, (_target, _view, next) => { retry = next; });
  runner.run(REFUND);
  answers[0]!.resolve({ status: "failed", code: "rejected" });
  await tick();
  assert.ok(retry);
  const previousRetry = retry;
  previousRetry();
  previousRetry();
  assert.equal(calls, 2, "two retry taps start only one attempt");
  answers[1]!.resolve({ status: "confirmed", digest: "confirmed" });
  await tick();
  previousRetry();
  assert.equal(calls, 2, "a stale toast cannot repeat a confirmed claim");
  runner.dispose();
  previousRetry();
  assert.equal(calls, 2);
});

test("a previous failure's retry cannot run after a newer attempt awaits confirmation", async () => {
  let calls = 0;
  let retry: (() => void) | undefined;
  const runner = createClaimRunner(async () => ++calls === 1 ? { status: "failed", code: "rejected" } : { status: "failed", code: "claim_pending", digest: "sent" }, (_target, _view, next) => { retry = next; });
  runner.run(REFUND);
  await tick();
  assert.ok(retry);
  const oldRetry = retry;
  runner.run(REFUND);
  await tick();
  assert.equal(retry, undefined);
  oldRetry();
  assert.equal(calls, 2);
});

test("R3-58-AC-7: a refused claim reads `Claiming`, then its published refusal, and can be tried again", async () => {
  const calls: ClaimTarget[] = [];
  const answers = [deferred(), deferred()];
  const settled: [string, ClaimView][] = [];
  const runner = createClaimRunner(
    (target) => {
      calls.push(target);
      return answers[calls.length - 1]!.promise;
    },
    (target, view) => settled.push([target.key, view]),
  );
  let changes = 0;
  runner.subscribe(() => (changes += 1));

  runner.run(REFUND);
  assert.deepEqual(runner.view(REFUND.key), { state: "claiming" });
  runner.run(REFUND);
  assert.equal(calls.length, 1, "a second press while it runs does nothing");

  answers[0]!.resolve({ status: "failed", code: "rejected" });
  await tick();
  assert.deepEqual(runner.view(REFUND.key), {
    state: "failed",
    code: "rejected",
    message: "You declined it in your wallet. Nothing was claimed. Code: rejected.",
  });
  assert.deepEqual(settled.map(([key, view]) => [key, view.state]), [[REFUND.key, "failed"]], "the screen reads the log again after a refusal too");

  runner.run(REFUND);
  assert.equal(calls.length, 2, "the refusal leaves it ready to try again");
  answers[1]!.resolve({ status: "confirmed", digest: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi" });
  await tick();
  assert.deepEqual(runner.view(REFUND.key), { state: "done", digest: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi" });
  assert.equal(changes, 4, "claiming, failed, claiming, done");
  assert.deepEqual(runner.view("refund:other"), { state: "idle" });
});

test("a path that throws, or rejects, is a refusal under its own code, never a silent stop", async () => {
  const throwing = createClaimRunner(() => {
    throw new Error("wallet bridge missing");
  });
  throwing.run(REFUND);
  await tick();
  assert.equal(throwing.view(REFUND.key).state, "failed");
  assert.equal((throwing.view(REFUND.key) as { code: string }).code, CLAIM_UNREACHABLE);

  const rejecting = createClaimRunner(() => Promise.reject(new Error("MoveAbort(…) 7")));
  rejecting.run(REFUND);
  await tick();
  assert.equal((rejecting.view(REFUND.key) as { code: string }).code, CLAIM_UNREACHABLE, "the raw error is not repeated");
});

test("leaving the screen aborts a running claim and shows nothing it answers later", async () => {
  const answer = deferred();
  let signal: AbortSignal | null = null;
  const runner = createClaimRunner((_target, given) => {
    signal = given;
    return answer.promise;
  });
  runner.run(REFUND);
  runner.dispose();
  assert.equal((signal as AbortSignal | null)?.aborted, true);
  answer.resolve({ status: "confirmed", digest: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi" });
  await tick();
  assert.deepEqual(runner.view(REFUND.key), { state: "claiming" }, "the late answer is dropped");
  runner.run({ ...REFUND, key: "refund:new" });
  assert.deepEqual(runner.view("refund:new"), { state: "idle" }, "nothing new runs while disposed");
  runner.resume();
  runner.run({ ...REFUND, key: "refund:new" });
  assert.deepEqual(runner.view("refund:new"), { state: "claiming" });
});

test("R3-63: a path claims the kinds it names, every kind when it names none, and nothing without a path", () => {
  const answer = async (): Promise<ClaimOutcome> => ({ status: "failed", code: "rejected" });
  const named: ClaimPath = Object.assign(answer, { kinds: ["claim_refund", "claim_tokens"] as const });
  assert.equal(claimPathSupports(named, "claim_refund"), true);
  assert.equal(claimPathSupports(named, "claim_tokens"), true);
  // The vendored SDK has no vesting claim builder: the vesting item draws no button.
  assert.equal(claimPathSupports(named, "claim_vesting"), false);
  assert.equal(claimPathSupports(async () => ({ status: "confirmed", digest: "d" }), "claim_vesting"), true);
  assert.equal(claimPathSupports(undefined, "claim_refund"), false);
  // R3-63's own codes each have a line of their own.
  for (const code of ["nothing_to_claim", "claim_not_open", "claim_unavailable", "claim_conflict", "sign_failed", "claim_pending", "claim_unsupported"]) {
    assert.notEqual(claimRefusalCopy(code), claimRefusalCopy("something_new"), code);
  }
});


test("vesting claim labels retain the exact amount while claiming and after confirmation", () => {
  const label = "Claim 21,111.123456789 LUMN";
  assert.equal(claimButtonText({ state: "claiming" }, "Claim", "claim_tokens"), "Claiming");
  assert.equal(claimButtonText({ state: "claiming" }, label, "claim_vesting"), "Claiming 21,111.123456789 LUMN");
  assert.equal(claimButtonText({ state: "done", digest: "d" }, label, "claim_vesting"), "Claimed 21,111.123456789 LUMN");
});

test("confirmed one-shot claims stay guarded after inclusion and late acknowledgements cannot clear a newer claim", async () => {
  let calls = 0;
  const runner = createClaimRunner(async () => ({ status: "confirmed", digest: `digest-${++calls}` }));
  runner.run(REFUND);
  await tick();
  runner.acknowledge(REFUND.key, "unrelated");
  assert.equal(runner.pending().size, 1);
  runner.acknowledge(REFUND.key, "digest-1");
  assert.equal(runner.pending().size, 0);
  runner.run(REFUND);
  assert.equal(calls, 1, "a stale response cannot offer the one-shot claim again");
});

test("vesting uses exact inclusion evidence, supports repeated claims, and preserves confirmation over stale responses after a refusal", async () => {
  const target: ClaimTarget = { ...REFUND, kind: "claim_vesting", key: "vesting:schedule", scheduleId: "schedule", vesting: { claimed: "9007199254740993.000000001", claimable: "1.000000009" } };
  let calls = 0;
  const runner = createClaimRunner(async () => ++calls === 2 ? { status: "failed", code: "rejected" } : { status: "confirmed", digest: `digest-${calls}` });
  runner.run(target);
  await tick();
  assert.equal(runner.view(target.key, "9007199254740993.000000002").state, "done", "a partial increase is insufficient");
  assert.equal(runner.view(target.key, "9007199254740994.000000009").state, "done", "one atom short is insufficient");
  const indexed = "9007199254740994.000000010";
  assert.equal(runner.view(target.key, indexed).state, "idle");
  const next = { ...target, vesting: { claimed: indexed, claimable: "0.5" } };
  runner.run(next);
  await tick();
  assert.equal(runner.view(target.key, indexed).state, "failed", "the next refusal is actionable on the current snapshot");
  assert.equal(runner.view(target.key, target.vesting!.claimed).state, "done", "older snapshots retain the previous confirmation");
  runner.run(next);
  await tick();
  assert.equal(calls, 3);
  runner.acknowledge(target.key, "digest-1");
  assert.equal(runner.pending().get(target.key)?.digest, "digest-3");
  assert.equal(runner.view(target.key, indexed).state, "done");
  assert.equal(runner.view(target.key, "9007199254740994.500000010").state, "idle");
});

test("a late aborted answer cannot release the guard on a new attempt after a development remount", async () => {
  const answers = [deferred(), deferred()];
  let calls = 0;
  const runner = createClaimRunner(() => answers[calls++]!.promise);
  runner.run(REFUND);
  runner.dispose();
  runner.resume();
  runner.run(REFUND);
  answers[0]!.resolve({ status: "confirmed", digest: "aborted" });
  await tick();
  runner.run(REFUND);
  assert.equal(calls, 2, "the second attempt still holds the guard");
  answers[1]!.resolve({ status: "confirmed", digest: "current" });
  await tick();
  assert.deepEqual(runner.view(REFUND.key), { state: "done", digest: "current" });
});

test("fee collection stays confirmed until indexed receipts advance, then permits another collection",async () => {
  let calls=0;
  const runner=createClaimRunner(async () => { calls++; return { status:"confirmed",digest:"collection" }; });
  const target:ClaimTarget={ key:"collect_fees:vault",kind:"collect_fees",presaleId:"sale",vaultId:"vault",collection:{ received:"1:2" },done:{ title:"Collected",sub:"" } };
  runner.run(target);
  runner.run(target);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls,1);
  assert.equal(runner.view(target.key,undefined,"1:2").state,"done");
  assert.equal(runner.view(target.key,undefined,"0.999999999:2").state,"done","an older snapshot cannot unlock another collection");
  assert.equal(runner.view(target.key,undefined,"1.000:2.0").state,"done","formatting is not a payment");
  runner.run(target);
  assert.equal(calls,1);
  assert.equal(runner.view(target.key,undefined,"2:3").state,"idle");
  runner.run({ ...target,collection:{ received:"2:3" } });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls,2);
  runner.dispose();
});
