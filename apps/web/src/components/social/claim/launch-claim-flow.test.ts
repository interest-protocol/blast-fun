import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import { fastTimeouts } from "../../../../test/fixtures/social/fast-timeouts.ts";
afterEach(() => mock.restoreAll());

import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";

import type { LaunchClaim } from "@blast/core/modules/social/contracts/launch-claims.ts";

import { CLAIM_UNREACHABLE, launchClaimTarget } from "./claims";
import { FAKE_SIGNATURE, FAKE_SPONSOR, sponsoredSigner, transactionBytesFor } from "../../../../test/fixtures/social/claim/claim-doubles.ts";
import { CLAIM_PENDING, type ClaimFlowDependencies, type ClaimSigner } from "./claim-flow";
import { isLaunchClaim } from "./launch-claim-client";
import { runLaunchClaim } from "./launch-claim-flow";

/**
 * LP-12's client flow over scripted answers: the presale claim's order (record before anything
 * is signed, the digest before anything is executed) with the sponsorship in the record's
 * answer, and every refusal reported when nothing was sent. The route itself is
 * tested over Postgres in `launch-claims.integration.test.ts`.
 */

const LAUNCH = normalizeSuiAddress(`0x${"1a".repeat(32)}`);
const KAI = normalizeSuiAddress(`0x${"9a11e700".padStart(64, "0")}`);
const REQUEST = "0b8f6a52-6c1e-4d0b-9a57-3f2c1d4e5a6b";
const kindTransaction = new Transaction();
kindTransaction.moveCall({ target: "0x2::coin::zero", typeArguments: ["0x2::sui::SUI"] });
const KIND = await kindTransaction.build({ onlyTransactionKind: true });
const SPONSORED = transactionBytesFor(KIND, KAI, FAKE_SPONSOR);
const SPONSORED_DIGEST = TransactionDataBuilder.getDigestFromBytes(SPONSORED);
const SPONSORSHIP = { reservation_id: "res-1", transaction_bytes: toBase64(SPONSORED), sponsor_signature: "", expires_at_ms: 9, gas_budget: "5000000" } as const;

const CURVE = launchClaimTarget({ launchId: LAUNCH, name: "Froggy" }, { vault: false, claimed: "0:0" });
const VAULT = launchClaimTarget({ launchId: LAUNCH, name: "Froggy" }, { vault: true, claimed: "5:7" });

type Call = Readonly<{ method: string; path: string; body: Record<string, unknown> | null }>;
type Answer = Readonly<{ status: number; body: unknown }>;

function claim(over: Partial<LaunchClaim> = {}): LaunchClaim {
  return {
    request_id: REQUEST,
    launch_id: LAUNCH,
    kind: "claim_launch_fees",
    state: "submitted",
    digest: null,
    failure_code: null,
    move_abort: null,
    fee: "sponsored",
    transaction_kind_bytes: toBase64(KIND),
    sponsored: SPONSORSHIP,
    created_at_ms: 1,
    settled_at_ms: null,
    ...over,
  };
}

const refusal = (status: number, code: string): Answer => ({ status, body: { error: { code, message: "refused" } } });

/** A scripted server: the launch claim route records (with the sponsorship), takes a digest (202 until `visibleAfter`), takes a failure; execute answers. */
function server(script: Partial<{ record: Answer; digest: Answer; settled: Partial<LaunchClaim>; visibleAfter: number; execute: Answer }> = {}) {
  const calls: Call[] = [];
  let digestCalls = 0;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ method: init?.method ?? "GET", path, body });
    let answer: Answer;
    if (path === `/api/social/me/launch-claims/${REQUEST}`) {
      if (body?.failure) answer = { status: 200, body: claim({ state: "failed", failure_code: body.failure as LaunchClaim["failure_code"], transaction_kind_bytes: null, sponsored: null, settled_at_ms: 2 }) };
      else if (body?.digest) {
        digestCalls += 1;
        answer = script.digest ?? (digestCalls > (script.visibleAfter ?? 1)
          ? { status: 200, body: claim({ state: "confirmed", digest: String(body.digest), transaction_kind_bytes: null, sponsored: null, settled_at_ms: 2, ...script.settled }) }
          : { status: 202, body: claim({ digest: String(body.digest), transaction_kind_bytes: null, sponsored: null }) });
      } else answer = script.record ?? { status: 201, body: claim() };
    } else if (path === "/api/presale/sponsor/res-1/execute") {
      answer = script.execute ?? { status: 200, body: { digest: SPONSORED_DIGEST, effects: { status: "success" } } };
    } else answer = refusal(404, "not_found");
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

async function run(
  signer: ClaimSigner | null,
  script: Parameters<typeof server>[0] = {},
  options: Partial<{ target: typeof CURVE }> = {},
) {
  const fake = server(script);
  fastTimeouts(() => {});
  mock.method(crypto, "randomUUID", () => REQUEST);
  const deps: ClaimFlowDependencies = {
    api: { getAccessToken: async () => null, fetch: fake.fetch },
    signer: async () => signer,
  };
  const outcome = await runLaunchClaim(deps, options.target ?? CURVE, new AbortController().signal);
  return { ...fake, outcome };
}

const steps = (calls: readonly Call[]) =>
  calls.map((call) =>
    call.path.startsWith("/api/social/me/launch-claims/")
      ? call.body?.digest ? "digest" : call.body?.failure ? `failure:${String(call.body.failure)}` : "record"
      : call.path.endsWith("/execute") ? "execute" : "other",
  );

test("LP-12: a sponsored claim records (the sponsorship comes with it), signs, records the digest, executes, then settles", async () => {
  const signed: Uint8Array[] = [];
  const result = await run(sponsoredSigner(KAI, { signed }));
  assert.deepEqual(result.outcome, { status: "confirmed", digest: SPONSORED_DIGEST });
  assert.deepEqual(steps(result.calls), ["record", "digest", "execute", "digest"]);
  // The client names the launch and the ledger, nothing else: the server finds the cap and the vault.
  assert.deepEqual(result.calls[0]!.body, { launch_id: LAUNCH, kind: "claim_launch_fees" });
  // The first digest carries its signed bytes: the server proves the wallet signed it before reserving it.
  assert.deepEqual(result.calls[1]!.body, { launch_id: LAUNCH, kind: "claim_launch_fees", digest: SPONSORED_DIGEST, transaction_bytes: toBase64(SPONSORED) });
  assert.deepEqual(result.calls[2]!.body, { user_signature: FAKE_SIGNATURE });
  assert.deepEqual(signed, [SPONSORED]);
});

test("LP-12: a vault claim is its own kind and key", async () => {
  assert.equal(VAULT.kind, "claim_launch_lp_fees");
  assert.notEqual(VAULT.key, CURVE.key);
  assert.deepEqual(VAULT.collection, { received: "5:7" });
  const result = await run(sponsoredSigner(KAI), { record: { status: 201, body: claim({ kind: "claim_launch_lp_fees" }) } }, { target: VAULT });
  assert.deepEqual(result.calls[0]!.body, { launch_id: LAUNCH, kind: "claim_launch_lp_fees" });
  assert.equal(result.outcome.status, "confirmed");
});

test("LP-12: a refused record signs nothing and answers its code; sponsored bytes that are not this claim are never signed", async () => {
  for (const [record, code] of [
    [refusal(409, "nothing_to_claim"), "nothing_to_claim"],
    [refusal(409, "claim_unavailable"), "claim_unavailable"],
    [refusal(429, "rate_limited"), "rate_limited"],
    [{ status: 201, body: claim({ state: "failed", failure_code: "dry_run_failed", transaction_kind_bytes: null, sponsored: null }) }, "dry_run_failed"],
  ] as const) {
    const signed: Uint8Array[] = [];
    const result = await run(sponsoredSigner(KAI, { signed }), { record });
    assert.deepEqual(result.outcome, { status: "failed", code }, code);
    assert.deepEqual(steps(result.calls), ["record"], code);
    assert.equal(signed.length, 0);
  }
  const signed: Uint8Array[] = [];
  const other = transactionBytesFor(KIND, `0x${"66".repeat(32)}`, FAKE_SPONSOR);
  const swapped = await run(sponsoredSigner(KAI, { signed }), { record: { status: 201, body: claim({ sponsored: { ...SPONSORSHIP, transaction_bytes: toBase64(other) } }) } });
  assert.deepEqual(swapped.outcome, { status: "failed", code: "mismatch" });
  assert.deepEqual(signed, []);
  assert.deepEqual(steps(swapped.calls), ["record", "failure:rejected"]);
  // No sponsorship for a sponsored signer: nothing is signed, and the unsent attempt expires.
  const unsponsored = await run(sponsoredSigner(KAI), { record: { status: 201, body: claim({ sponsored: null }) } });
  assert.deepEqual(unsponsored.outcome, { status: "failed", code: CLAIM_UNREACHABLE });
  assert.deepEqual(steps(unsponsored.calls), ["record"]);
  assert.deepEqual((await run(null)).outcome, { status: "failed", code: "blast_wallet_missing" });
});

test("LP-12: a declined signature is reported as rejected; a lost execution stays pending with its digest", async () => {
  const declined = await run(sponsoredSigner(KAI, { error: new Error("User rejected the request") }));
  assert.deepEqual(declined.outcome, { status: "failed", code: "rejected" });
  assert.equal(steps(declined.calls).at(-1), "failure:rejected");

  const lost = await run(sponsoredSigner(KAI), { visibleAfter: 99, execute: refusal(500, "internal") });
  assert.deepEqual(lost.outcome, { status: "failed", code: CLAIM_PENDING, digest: SPONSORED_DIGEST });

  const aborted = await run(sponsoredSigner(KAI), { settled: { state: "failed", failure_code: "execution_failed" } });
  assert.deepEqual(aborted.outcome, { status: "failed", code: "execution_failed" });
});

test("LP-12: the answer's shape is checked before anything is signed", () => {
  assert.equal(isLaunchClaim(claim()), true);
  assert.equal(isLaunchClaim(claim({ sponsored: null })), true);
  assert.equal(isLaunchClaim({ ...claim(), launch_id: "0x1" }), false);
  assert.equal(isLaunchClaim({ ...claim(), kind: "collect_fees" }), false);
  assert.equal(isLaunchClaim({ ...claim(), sponsored: { reservation_id: 1 } }), false);
});
