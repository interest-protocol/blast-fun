import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { TransactionDataBuilder } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";

import { reconcileTransaction, signAndSubmitOnce } from "./execution.ts";
import {
  createFixtureChain,
  fixtureBuyAdapter,
  fixtureWalletSigner,
  FIXTURE_LAUNCH_ID,
  NON_PRODUCTION_MANIFEST,
  type FixtureChain,
  type FixtureChainState,
} from "../../../../test/fixtures/launchpad/transaction/fixtures.ts";
import { runFreshPreflight } from "./preflight.ts";
import type { LaunchpadSigner } from "./signer.ts";

async function prepared(overrides: Partial<FixtureChainState> = {}, signer: LaunchpadSigner = fixtureWalletSigner()) {
  const fixture = createFixtureChain(overrides);
  const { outcome, deployment } = await runFreshPreflight({
    chain: { client: fixture.client, manifest: NON_PRODUCTION_MANIFEST, mode: "non-production" },
    signer,
    adapter: fixtureBuyAdapter,
    input: { launchId: FIXTURE_LAUNCH_ID, amount: "12.5" },
    reviewId: "r1",
  });
  assert.equal(outcome.status, "ready");
  if (outcome.status !== "ready" || !deployment) throw new Error("unreachable");
  return { fixture, review: outcome.review, deployment, signer };
}

function reconcile(fixture: FixtureChain, deployment: Awaited<ReturnType<typeof prepared>>["deployment"], digest: string) {
  return reconcileTransaction({ client: fixture.client, deployment, digest, completion: fixtureBuyAdapter.completion });
}

test("one approval produces one signature and one submission of the reviewed bytes", async () => {
  let requests = 0;
  const { fixture, review } = await prepared();
  const signer = fixtureWalletSigner({ onRequest: () => (requests += 1) });
  const result = await signAndSubmitOnce({ client: fixture.client, signer, review });
  assert.deepEqual(result, {
    status: "submitted",
    digest: TransactionDataBuilder.getDigestFromBytes(review.transactionBytes),
  });
  assert.equal(requests, 1);
  assert.equal(fixture.calls.execute, 1);
});

test("a declined signature submits nothing", async () => {
  const { fixture, review } = await prepared();
  const result = await signAndSubmitOnce({
    client: fixture.client,
    signer: fixtureWalletSigner({ decide: () => "reject" }),
    review,
  });
  assert.deepEqual(result, { status: "rejected" });
  assert.equal(fixture.calls.execute, 0);
});

test("wallet signing diagnostics distinguish causes and keep private provider details out of analytics", async (t) => {
  const events: unknown[] = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { va: (...args: unknown[]) => events.push(args) },
  });
  t.after(() => {
    if (previous) {
      Object.defineProperty(globalThis, "window", previous);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  });

  const { fixture, review, signer } = await prepared();
  async function attempt(error: unknown, kind: LaunchpadSigner["kind"] = "wallet") {
    return signAndSubmitOnce({
      client: fixture.client,
      review,
      signer: { ...signer, kind, async signTransaction() { throw error; } },
    });
  }

  assert.deepEqual(await attempt(new Error("Failed to open new window")), {
    status: "signature-failed",
    message: "The wallet could not sign. Reconnect it and retry. Nothing was submitted. Code: sign_failed.",
  });
  await attempt(new Error("No session found"));
  await attempt(new Error("Wrapper", {
    cause: new Error(`No account with address ${signer.address} is connected to Slush.`),
  }));
  await attempt(new Error(`The account ${signer.address} does not support the chain "sui:mainnet".`));
  await attempt({ privyErrorCode: "must_be_authenticated", message: "Authorization: Bearer fake-session-token" }, "privy");
  await attempt({ code: 4900, message: "fake-wallet-payload" });
  await attempt(new TypeError("Failed to fetch"));
  await attempt({ code: "arbitrary-private-value", message: "unrecognized private provider text" });
  await attempt({ message: null, cause: null });
  await attempt(new Error("No account with address ".padEnd(513, "x")));
  let causeReads = 0;
  const cyclic = {
    get cause(): unknown {
      assert.ok(++causeReads <= 4, "stop reading the wallet error after four levels");
      return cyclic;
    },
  };
  await attempt(cyclic);
  assert.deepEqual(await attempt(Object.assign(new Error("Cancelled"), { code: 4001 })), { status: "rejected" });

  assert.deepEqual(events, [
    ["event", { name: "wallet_signature_failed", data: { signer: "wallet", reason: "wallet_popup_open_failed" }, options: undefined }],
    ["event", { name: "wallet_signature_failed", data: { signer: "wallet", reason: "wallet_session_missing" }, options: undefined }],
    ["event", { name: "wallet_signature_failed", data: { signer: "wallet", reason: "wallet_account_unauthorized" }, options: undefined }],
    ["event", { name: "wallet_signature_failed", data: { signer: "wallet", reason: "wallet_network_unsupported" }, options: undefined }],
    ["event", { name: "wallet_signature_failed", data: { signer: "privy", reason: "privy_session_invalid", provider_code: "must_be_authenticated" }, options: undefined }],
    ["event", { name: "wallet_signature_failed", data: { signer: "wallet", reason: "wallet_disconnected", provider_code: 4900 }, options: undefined }],
    ["event", { name: "wallet_signature_failed", data: { signer: "wallet", reason: "wallet_network_request_failed" }, options: undefined }],
    ["event", { name: "wallet_signature_failed", data: { signer: "wallet", reason: "unrecognized_wallet_error" }, options: undefined }],
    ["event", { name: "wallet_signature_failed", data: { signer: "wallet", reason: "unrecognized_wallet_error" }, options: undefined }],
    ["event", { name: "wallet_signature_failed", data: { signer: "wallet", reason: "unrecognized_wallet_error" }, options: undefined }],
    ["event", { name: "wallet_signature_failed", data: { signer: "wallet", reason: "unrecognized_wallet_error" }, options: undefined }],
  ]);
  assert.equal(fixture.calls.execute, 0);
});

test("a signer that returns different bytes is never submitted", async () => {
  const { fixture, review, signer } = await prepared();
  const altered: LaunchpadSigner = {
    ...signer,
    async signTransaction() {
      const signed = await signer.signTransaction(review.transactionBytes);
      return { ...signed, bytes: toBase64(new Uint8Array([9, 9, 9])) };
    },
  };
  const result = await signAndSubmitOnce({ client: fixture.client, signer: altered, review });
  assert.equal(result.status, "signature-failed");
  assert.equal(result.status === "signature-failed" ? result.message : "", "The wallet returned a different transaction from the one you reviewed, so it was not submitted. Code: invalid_response.");
  assert.equal(fixture.calls.execute, 0);
});

test("a submission whose answer is lost is reported unknown with its digest, never resubmitted", async () => {
  const { fixture, review, signer } = await prepared({ execution: "unknown" });
  const result = await signAndSubmitOnce({ client: fixture.client, signer, review });
  assert.equal(result.status, "unknown");
  assert.equal(result.status === "unknown" && result.digest, TransactionDataBuilder.getDigestFromBytes(review.transactionBytes));
  assert.equal(result.status === "unknown" ? result.message : "", `Sui did not confirm whether transaction ${TransactionDataBuilder.getDigestFromBytes(review.transactionBytes)} was received. Do not sign again until it is resolved. Code: execution_unconfirmed.`);
  assert.equal(fixture.calls.execute, 1);
});

test("success needs checkpointed effects and the configured launchpad event", async () => {
  const { fixture, review, deployment, signer } = await prepared();
  const submitted = await signAndSubmitOnce({ client: fixture.client, signer, review });
  assert.equal(submitted.status, "submitted");
  if (submitted.status !== "submitted") return;
  assert.deepEqual(await reconcile(fixture, deployment, submitted.digest), {
    status: "succeeded",
    explorerUrl: `http://127.0.0.1:9001/tx/${submitted.digest}`,
  });
});

test("an on-chain abort is a failure with its explorer link", async () => {
  const { fixture, review, deployment, signer } = await prepared({ execution: "abort" });
  const submitted = await signAndSubmitOnce({ client: fixture.client, signer, review });
  if (submitted.status !== "submitted") return assert.fail(submitted.status);
  assert.deepEqual(await reconcile(fixture, deployment, submitted.digest), {
    status: "failed",
    explorerUrl: `http://127.0.0.1:9001/tx/${submitted.digest}`,
    message: "The transaction failed on Sui: the network rejected it. Its changes were reverted; only network fees were spent. Code: execution_failed.",
  });
});

test("missing or foreign-package evidence and unconfirmed transactions are never success", async () => {
  for (const evidence of ["missing", "foreign"] as const) {
    const { fixture, review, deployment, signer } = await prepared({ evidence });
    const submitted = await signAndSubmitOnce({ client: fixture.client, signer, review });
    if (submitted.status !== "submitted") return assert.fail(submitted.status);
    const outcome = await reconcile(fixture, deployment, submitted.digest);
    assert.equal(outcome.status === "pending" && outcome.reason, "evidence-missing", evidence);
    assert.equal(outcome.status === "pending" ? outcome.message : "", `Transaction ${submitted.digest} completed, but its expected Blast record was not found. Check the transaction before signing again. Code: evidence-missing.`, evidence);
  }
  const { fixture, review, deployment, signer } = await prepared({ confirmation: "pending" });
  const submitted = await signAndSubmitOnce({ client: fixture.client, signer, review });
  if (submitted.status !== "submitted") return assert.fail(submitted.status);
  const pending = await reconcile(fixture, deployment, submitted.digest);
  assert.equal(pending.status === "pending" && pending.reason, "confirmation-pending");
  assert.equal(pending.status === "pending" ? pending.message : "", `Sui has not confirmed transaction ${submitted.digest} yet. Check again before signing anything new. Code: execution_unconfirmed.`);
  fixture.state.confirmation = "checkpointed";
  assert.equal((await reconcile(fixture, deployment, submitted.digest)).status, "succeeded");
  assert.equal(fixture.calls.execute, 1, "rechecking reads by digest only");
});

test("onSigned runs once between the returned signature and the submission, and its failure submits nothing", async () => {
  const { fixture, review } = await prepared();
  const seen: number[] = [];
  const signer = fixtureWalletSigner();
  const result = await signAndSubmitOnce({
    client: fixture.client,
    signer,
    review,
    onSigned: () => void seen.push(fixture.calls.execute),
  });
  assert.equal(result.status, "submitted");
  assert.deepEqual(seen, [0], "called once, before the transaction was sent");

  const refused = await prepared();
  const failed = await signAndSubmitOnce({
    client: refused.fixture.client,
    signer,
    review: refused.review,
    onSigned: () => {
      throw new Error("storage is full");
    },
  });
  assert.equal(failed.status, "signature-failed");
  assert.equal(failed.status === "signature-failed" ? failed.message : "", "The signed transaction could not be recorded, so it was not submitted. Code: transaction_record_failed.");
  assert.doesNotMatch(failed.status === "signature-failed" ? failed.message : "", /storage is full/);
  assert.equal(refused.fixture.calls.execute, 0);

  const declined = await prepared();
  let called = false;
  await signAndSubmitOnce({
    client: declined.fixture.client,
    signer: fixtureWalletSigner({ decide: () => "reject" }),
    review: declined.review,
    onSigned: () => void (called = true),
  });
  assert.equal(called, false, "a declined signature never reaches onSigned");
});

test("onSigned receives the signed transaction's digest, the one that is then submitted", async () => {
  const { fixture, review } = await prepared();
  const digests: string[] = [];
  const result = await signAndSubmitOnce({
    client: fixture.client,
    signer: fixtureWalletSigner(),
    review,
    onSigned: (digest) => void digests.push(digest),
  });
  assert.equal(result.status, "submitted");
  assert.deepEqual(digests, [TransactionDataBuilder.getDigestFromBytes(review.transactionBytes)]);
  assert.deepEqual(digests, [result.status === "submitted" ? result.digest : ""]);
});

test("an asynchronous onSigned is awaited: its rejection submits nothing, its completion comes before the submission", async () => {
  const rejected = await prepared();
  const failed = await signAndSubmitOnce({
    client: rejected.fixture.client,
    signer: fixtureWalletSigner(),
    review: rejected.review,
    onSigned: async () => {
      await Promise.resolve();
      throw new Error("the record was not saved");
    },
  });
  assert.equal(failed.status, "signature-failed");
  assert.equal(rejected.fixture.calls.execute, 0);

  const awaited = await prepared();
  const order: string[] = [];
  const result = await signAndSubmitOnce({
    client: awaited.fixture.client,
    signer: fixtureWalletSigner(),
    review: awaited.review,
    onSigned: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`recorded after ${awaited.fixture.calls.execute} executions`);
    },
  });
  assert.equal(result.status, "submitted");
  assert.deepEqual(order, ["recorded after 0 executions"]);
});

test("sponsor refusals permit another review; lost sponsor replies retain the digest without a direct submission", async (t) => {
  const ready = await prepared();
  const signer = { ...ready.signer, kind: "privy" as const, accessToken: async () => "fixture-token" };
  const review = { ...ready.review, sponsorReservationId: "00000000-0000-4000-8000-000000000001" };
  let calls = 0;
  let code = "reservation_expired";
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ error: { code } }, { status: code === "reservation_expired" ? 409 : 503 });
  });
  assert.equal((await signAndSubmitOnce({ client: ready.fixture.client, signer, review })).status, "signature-failed");
  code = "execution_unconfirmed";
  const unknown = await signAndSubmitOnce({ client: ready.fixture.client, signer, review });
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.status === "unknown" && unknown.digest, TransactionDataBuilder.getDigestFromBytes(review.transactionBytes));
  assert.equal(calls, 2);
  assert.equal(ready.fixture.calls.execute, 0, "sponsored trades never fall back to a direct submission");
});

async function sponsoredSubmission(t: TestContext, answer: (digest: string) => Response) {
  const { fixture, review } = await prepared();
  const digest = TransactionDataBuilder.getDigestFromBytes(review.transactionBytes);
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    paths.push(String(input));
    return answer(digest);
  });
  const result = await signAndSubmitOnce({ client: fixture.client, signer: fixtureWalletSigner(), review: { ...review, sponsorReservationId: "reservation-1" } });
  return { result, paths, executed: fixture.calls.execute, digest };
}

test("a sponsor that executed the reviewed digest submits it", async (t) => {
  const { result, paths, executed, digest } = await sponsoredSubmission(t, (digest) => Response.json({ digest, effects: { status: "success" } }));
  assert.deepEqual(result, { status: "submitted", digest });
  assert.deepEqual(paths, ["/api/presale/sponsor/reservation-1/execute"]);
  assert.equal(executed, 0, "a sponsored action never goes to the fullnode");
});

test("a sponsor that executed another digest leaves the action unconfirmed, never submitted", async (t) => {
  const { result, digest } = await sponsoredSubmission(t, () => Response.json({ digest: "another-digest", effects: { status: "success" } }));
  assert.deepEqual(result, {
    status: "unknown",
    digest,
    message: `Sui did not confirm whether transaction ${digest} was received. Do not sign again until it is resolved. Code: execution_unconfirmed.`,
  });
});

test("a sponsor refusal before submission is reported with its code and reference", async (t) => {
  const { result } = await sponsoredSubmission(t, () => Response.json({ error: { code: "reservation_expired" } }, { status: 410, headers: { "x-request-id": "req-1" } }));
  assert.deepEqual(result, {
    status: "signature-failed",
    message: "Blast could not sponsor this trade. Nothing was submitted. Review again to retry. Code: reservation_expired. Reference: req-1.",
  });
});

test("a sponsor that may have submitted answers execution_unconfirmed, and the action stays unconfirmed", async (t) => {
  const { result, digest } = await sponsoredSubmission(t, () => Response.json({ error: { code: "execution_unconfirmed" } }, { status: 400, headers: { "x-request-id": "req-2" } }));
  assert.deepEqual(result, {
    status: "unknown",
    digest,
    message: `Sui did not confirm whether transaction ${digest} was received. Do not sign again until it is resolved. Code: execution_unconfirmed.`,
  });
});

test("a sponsor server error stays unconfirmed even with a pre-submission code", async (t) => {
  const { result, digest } = await sponsoredSubmission(t, () => Response.json({ error: { code: "reservation_expired" } }, { status: 503 }));
  assert.deepEqual(result, {
    status: "unknown",
    digest,
    message: `Sui did not confirm whether transaction ${digest} was received. Do not sign again until it is resolved. Code: execution_unconfirmed.`,
  });
});
