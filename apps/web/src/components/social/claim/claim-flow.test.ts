import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import { fastTimeouts } from "../../../../test/fixtures/social/fast-timeouts.ts";
afterEach(() => mock.restoreAll());

import { TransactionDataBuilder } from "@mysten/sui/transactions";
import { fromBase64, normalizeStructTag, normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";

import { claimTestIdentity } from "../../../../../../packages/server/test/fixtures/modules/social/claims/claim-fixtures.ts";
import { claimTransactionKind } from "@blast/server/modules/social/claims/chain.ts";
import type { SocialClaim } from "@blast/core/modules/social/contracts/claims.ts";

import type { PresaleClaimTarget } from "./claims";
import { claimRefusalCopy, CLAIM_UNREACHABLE } from "./claims";
import { FAKE_SIGNATURE, FAKE_SPONSOR, sponsoredSigner, transactionBytesFor } from "../../../../test/fixtures/social/claim/claim-doubles.ts";
import { SETTLE_DELAYS_MS } from "#web/components/social/sponsored-transaction.ts";
import { CLAIM_PENDING, claimFailureCode, runClaim, type ClaimFlowDependencies, type ClaimSigner } from "./claim-flow";

/**
 * R3-63's client flow over scripted answers: the order (record before
 * anything is signed, the digest before anything is executed), the
 * sponsored path, every refusal reported to the server when nothing was sent, and the
 * code each failure is shown with. The route itself is tested over Postgres
 * in `claims.integration.test.ts`; here the server is a script.
 */

const identity = claimTestIdentity();
const SALE = `0x${"5a1e".padStart(64, "0")}`;
const KAI = normalizeSuiAddress(`0x${"9a11e700".padStart(64, "0")}`);
const TOKEN = normalizeStructTag(`0x${"c0".padStart(64, "0")}::hlcn::HLCN`);
const USDC = normalizeStructTag("0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC");
const REQUEST = "0b8f6a52-6c1e-4d0b-9a57-3f2c1d4e5a6b";
const KIND = await claimTransactionKind(identity, { objectId: SALE, initialSharedVersion: "4242", saleToken: TOKEN, quote: USDC }, KAI);
const SPONSORED = transactionBytesFor(KIND, KAI, FAKE_SPONSOR);
const SPONSORED_DIGEST = TransactionDataBuilder.getDigestFromBytes(SPONSORED);

const REFUND: PresaleClaimTarget = { key: `refund:${SALE}`, kind: "claim_refund", presaleId: SALE, done: { title: "$250 refund claimed", sub: "From Halcyon" } };

type Call = Readonly<{ method: string; path: string; body: Record<string, unknown> | null; authorization: string | null; credentials: string | undefined }>;
type Answer = Readonly<{ status: number; body: unknown }>;

function claim(over: Partial<SocialClaim> = {}): SocialClaim {
  return {
    request_id: REQUEST,
    presale_id: SALE,
    kind: "claim_refund",
    state: "submitted",
    digest: null,
    failure_code: null,
    move_abort: null,
    fee: "sponsored",
    transaction_kind_bytes: toBase64(KIND),
    created_at_ms: 1,
    settled_at_ms: null,
    ...over,
  };
}

const refusal = (status: number, code: string): Answer => ({ status, body: { error: { code, message: "refused" } } });

/**
 * A scripted server. The claims route records (201 with the kind), takes a
 * digest (202 until `visibleAfter` settle reads, then `settled`), and takes a
 * failure (200 failed); the sponsor answers the sponsored bytes; execute
 * answers their digest. Each can be overridden.
 */
function server(script: Partial<{
  record: Answer;
  digest: Answer;
  settled: Partial<SocialClaim>;
  visibleAfter: number;
  sponsor: Answer;
  execute: Answer;
  network: boolean;
}> = {}) {
  const calls: Call[] = [];
  let digestCalls = 0;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ method: init?.method ?? "GET", path, body, authorization: headers.get("authorization"), credentials: init?.credentials });
    if (script.network) throw new TypeError("network down");
    let answer: Answer;
    if (path === `/api/social/me/claims/${REQUEST}`) {
      if (body?.failure) answer = { status: 200, body: claim({ state: "failed", failure_code: body.failure as SocialClaim["failure_code"], transaction_kind_bytes: null, settled_at_ms: 2 }) };
      else if (body?.digest) {
        digestCalls += 1;
        answer =
          script.digest ??
          (digestCalls > (script.visibleAfter ?? 1)
            ? { status: 200, body: claim({ state: "confirmed", digest: String(body.digest), transaction_kind_bytes: null, settled_at_ms: 2, ...script.settled }) }
            : { status: 202, body: claim({ digest: String(body.digest), transaction_kind_bytes: null }) });
      } else answer = script.record ?? { status: 201, body: claim() };
    } else if (path === "/api/presale/sponsor") {
      answer = script.sponsor ?? { status: 200, body: { reservation_id: "res-1", transaction_bytes: toBase64(SPONSORED), expires_at_ms: 9 } };
    } else if (path === "/api/presale/sponsor/res-1/execute") {
      answer = script.execute ?? { status: 200, body: { digest: SPONSORED_DIGEST, effects: { status: "success" } } };
    } else answer = refusal(404, "not_found");
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

/** `executed` is every call that reached the sponsor's execute endpoint. */
type Harness = ReturnType<typeof server> & Readonly<{ executed: readonly Call[]; slept: number[] }>;

async function run(
  signer: ClaimSigner | null,
  script: Parameters<typeof server>[0] = {},
  options: Partial<{ target: PresaleClaimTarget; signal: AbortSignal; token: string | null }> = {},
): Promise<Harness & Readonly<{ outcome: Awaited<ReturnType<typeof runClaim>> }>> {
  const fake = server(script);
  const slept: number[] = [];
  fastTimeouts((ms) => slept.push(ms));
  mock.method(crypto, "randomUUID", () => REQUEST);
  const deps: ClaimFlowDependencies = {
    api: { getAccessToken: async () => options.token ?? null, fetch: fake.fetch },
    signer: async () => signer,
  };
  const outcome = await runClaim(deps, options.target ?? REFUND, options.signal ?? new AbortController().signal);
  const executed = fake.calls.filter((call) => call.path.endsWith("/execute"));
  return { ...fake, executed, slept, outcome };
}

const steps = (calls: readonly Call[]) =>
  calls.map((call) =>
    call.path.startsWith("/api/social/me/claims/")
      ? call.body?.digest
        ? "digest"
        : call.body?.failure
          ? `failure:${String(call.body.failure)}`
          : "record"
      : call.path.endsWith("/execute")
        ? "execute"
        : "sponsor",
  );

test("R3-63: a sponsored claim records, sponsors, signs, records the digest, executes, then settles — in that order", async () => {
  const signed: Uint8Array[] = [];
  const result = await run(sponsoredSigner(KAI, { signed }), {}, { token: "privy-token" });
  assert.deepEqual(result.outcome, { status: "confirmed", digest: SPONSORED_DIGEST });
  assert.deepEqual(steps(result.calls), ["record", "sponsor", "digest", "execute", "digest"]);
  // The kind the route answered is what the sponsor got, from Kai, as a `claim` intent.
  assert.deepEqual(result.calls[1]!.body, { sender: KAI, presale_id: SALE, transaction_kind_bytes: toBase64(KIND), intent: "claim" });
  assert.deepEqual(result.calls[0]!.body, { presale_id: SALE, kind: "claim_refund" });
  assert.deepEqual(result.calls[2]!.body, { presale_id: SALE, kind: "claim_refund", digest: SPONSORED_DIGEST, transaction_bytes: toBase64(SPONSORED) });
  assert.deepEqual(result.calls[3]!.body, { user_signature: FAKE_SIGNATURE });
  // Exactly the sponsor's bytes were signed, after the record and before the digest.
  assert.deepEqual(signed, [SPONSORED]);
  // Every call is a signed-in social call (OA-16): the Privy token, same-origin credentials.
  for (const call of result.calls) assert.deepEqual([call.authorization, call.credentials], ["Bearer privy-token", "same-origin"]);
});

test("R3-63: a refused record signs nothing and answers its published code; a dry run's abort is shown by meaning", async () => {
  for (const [record, code] of [
    [refusal(409, "nothing_to_claim"), "nothing_to_claim"],
    [refusal(409, "claim_unavailable"), "claim_unavailable"],
    [refusal(429, "rate_limited"), "rate_limited"],
    [{ status: 201, body: claim({ state: "failed", failure_code: "dry_run_failed", move_abort: "ENoCommitment", transaction_kind_bytes: null }) }, "already_claimed"],
    [{ status: 201, body: claim({ state: "failed", failure_code: "dry_run_failed", move_abort: "EInvalidLifecycle", transaction_kind_bytes: null }) }, "claim_not_open"],
    [{ status: 201, body: claim({ state: "failed", failure_code: "dry_run_failed", move_abort: null, transaction_kind_bytes: null }) }, "dry_run_failed"],
  ] as const) {
    const signed: Uint8Array[] = [];
    const result = await run(sponsoredSigner(KAI, { signed }), { record });
    assert.deepEqual(result.outcome, { status: "failed", code }, code);
    assert.deepEqual(steps(result.calls), ["record"], code);
    assert.equal(signed.length, 0);
  }
  const down = await run(sponsoredSigner(KAI), { network: true });
  assert.deepEqual(down.outcome, { status: "failed", code: CLAIM_UNREACHABLE });
});

test("R3-63: a declined signature is reported as rejected, so the attempt is a failed row, never a pending one", async () => {
  const refuse = new Error("User rejected the request");
  const result = await run(sponsoredSigner(KAI, { error: refuse }));
  assert.deepEqual(result.outcome, { status: "failed", code: "rejected" });
  assert.equal(steps(result.calls).at(-1), "failure:rejected");
  assert.ok(!steps(result.calls).includes("digest"));
  assert.deepEqual(result.executed, []);
  // A signer that broke (not a refusal) is reported the same way, and shown as its own failure.
  const broken = await run(sponsoredSigner(KAI, { error: new Error("iframe unavailable") }));
  assert.deepEqual(broken.outcome, { status: "failed", code: "sign_failed" });
  assert.equal(steps(broken.calls).at(-1), "failure:rejected");
});

test("R3-63: the sponsor's refusals: its dry run is reported; its pool or budget leaves the attempt to expire; other bytes are never signed", async () => {
  const dry = await run(sponsoredSigner(KAI), { sponsor: refusal(422, "dry_run_failed") });
  assert.deepEqual(dry.outcome, { status: "failed", code: "dry_run_failed" });
  assert.deepEqual(steps(dry.calls), ["record", "sponsor", "failure:dry_run_failed"]);

  const pool = await run(sponsoredSigner(KAI), { sponsor: refusal(503, "pool_unavailable") });
  assert.deepEqual(pool.outcome, { status: "failed", code: "pool_unavailable" });
  assert.deepEqual(steps(pool.calls), ["record", "sponsor"]);

  const signed: Uint8Array[] = [];
  const swapped = transactionBytesFor(KIND, `0x${"66".repeat(32)}`, FAKE_SPONSOR);
  const other = await run(sponsoredSigner(KAI, { signed }), {
    sponsor: { status: 200, body: { reservation_id: "res-1", transaction_bytes: toBase64(swapped), expires_at_ms: 9 } },
  });
  assert.deepEqual(other.outcome, { status: "failed", code: "mismatch" });
  assert.deepEqual(signed, []);
  assert.deepEqual(steps(other.calls), ["record", "sponsor", "failure:rejected"]);
});

test("R3-63: a digest the server refused is never executed", async () => {
  const refused = await run(sponsoredSigner(KAI), { digest: refusal(409, "claim_conflict") });
  assert.deepEqual(refused.outcome, { status: "failed", code: "claim_conflict" });
  assert.ok(!steps(refused.calls).includes("execute"));
  assert.deepEqual(refused.executed, []);
});

test("R3-63: the settlement decides; while Sui does not show it, the execution's own answer stands, or the claim is pending", async () => {
  const aborted = await run(sponsoredSigner(KAI), { settled: { state: "failed", failure_code: "execution_failed", move_abort: "ENoCommitment" } });
  assert.deepEqual(aborted.outcome, { status: "failed", code: "already_claimed" });

  const invisible = 99;
  const success = await run(sponsoredSigner(KAI), { visibleAfter: invisible });
  assert.deepEqual(success.outcome, { status: "confirmed", digest: SPONSORED_DIGEST });
  assert.equal(success.slept.length, SETTLE_DELAYS_MS.length);

  const failed = await run(sponsoredSigner(KAI), {
    visibleAfter: invisible,
    execute: { status: 200, body: { digest: SPONSORED_DIGEST, effects: { status: "failure" } } },
  });
  assert.deepEqual(failed.outcome, { status: "failed", code: "execution_failed" });

  // A lost sponsor answer may have reached Sui: the claim is pending under its digest.
  const lost = await run(sponsoredSigner(KAI), { visibleAfter: invisible, execute: refusal(500, "internal") });
  assert.deepEqual(lost.outcome, { status: "failed", code: CLAIM_PENDING, digest: SPONSORED_DIGEST });
  assert.ok(claimRefusalCopy(CLAIM_PENDING).startsWith("Sent."));
});

test("P-13: a vesting claim names its schedule on every call; one without a schedule never signs", async () => {
  const schedule = `0x${"70".repeat(32)}`;
  const vesting: PresaleClaimTarget = { key: `vesting:${schedule}`, kind: "claim_vesting", presaleId: SALE, scheduleId: schedule, done: { title: "x", sub: "y" } };
  const claimed = await run(sponsoredSigner(KAI), {}, { target: vesting });
  assert.deepEqual(claimed.outcome, { status: "confirmed", digest: SPONSORED_DIGEST });
  const own = claimed.calls.filter((call) => call.path.startsWith("/api/social/me/claims/"));
  assert.ok(own.length >= 2);
  for (const call of own) assert.deepEqual([call.body?.kind, call.body?.schedule_id], ["claim_vesting", schedule]);
  assert.equal(claimed.calls.find((call) => call.path === "/api/presale/sponsor")?.body?.intent, "claim");

  const unsupported = await run(sponsoredSigner(KAI), {}, { target: { ...vesting, scheduleId: undefined } });
  assert.deepEqual(unsupported.outcome, { status: "failed", code: "claim_unsupported" });
  assert.deepEqual(unsupported.calls, []);
});

test("creator actions carry their immutable vault through signing and settlement", async () => {
  const vault = `0x${"71".repeat(32)}`;
  for (const kind of ["collect_fees", "claim_residuals"] as const) {
    const target: PresaleClaimTarget = { key: `${kind}:${vault}`, kind, presaleId: SALE, vaultId: vault, done: { title: "x", sub: "y" } };
    const result = await run(sponsoredSigner(KAI), { record: { status: 201, body: claim({ kind }) }, settled: { kind } }, { target });
    assert.equal(result.outcome.status, "confirmed");
    const calls = result.calls.filter((call) => call.path.startsWith("/api/social/me/claims/"));
    assert.ok(calls.length >= 2);
    for (const call of calls) assert.deepEqual([call.body?.kind, call.body?.vault_id, call.body?.schedule_id], [kind, vault, undefined]);
    const missing = await run(sponsoredSigner(KAI), {}, { target: { ...target, vaultId: undefined } });
    assert.deepEqual(missing.outcome, { status: "failed", code: "claim_unsupported" });
    assert.deepEqual(missing.calls, []);
  }
});

test("R3-63: a missing wallet and a screen that went away before signing never sign", async () => {

  const missing = await run(null);
  assert.deepEqual(missing.outcome, { status: "failed", code: "blast_wallet_missing" });
  assert.deepEqual(missing.calls, []);

  const controller = new AbortController();
  controller.abort();
  const signed: Uint8Array[] = [];
  const gone = await run(sponsoredSigner(KAI, { signed }), {}, { signal: controller.signal });
  assert.deepEqual(gone.outcome, { status: "failed", code: "rejected" });
  assert.deepEqual(signed, []);
  assert.equal(steps(gone.calls).at(-1), "failure:rejected");
});

test("R3-63: every code the flow answers has its own refusal copy, and the abort names map by meaning", () => {
  for (const code of ["nothing_to_claim", "already_claimed", "claim_not_open", "claim_unavailable", "claim_conflict", "sign_failed", "claim_unsupported", CLAIM_PENDING]) {
    assert.notEqual(claimRefusalCopy(code), claimRefusalCopy("something_else"), code);
  }
  assert.equal(claimFailureCode({ failure_code: "dry_run_failed", move_abort: "ENoCommitment" }), "already_claimed");
  assert.equal(claimFailureCode({ failure_code: "execution_failed", move_abort: "EInvalidLifecycle" }), "claim_not_open");
  assert.equal(claimFailureCode({ failure_code: "dry_run_failed", move_abort: "ENothingClaimable" }), "nothing_to_claim");
  assert.equal(claimFailureCode({ failure_code: "rejected", move_abort: null }), "rejected");
  assert.equal(claimFailureCode({ failure_code: null, move_abort: null }), "execution_failed");
  // The bytes the doubles build carry the kind unchanged (what `readSponsoredBytes` checks).
  assert.ok(fromBase64(toBase64(SPONSORED)).length > KIND.length);
});

test("malformed claim kind and sponsor bytes fail before signing or executing", async () => {
  for (const stage of ["kind", "sponsor"]) {
    const signed: Uint8Array[] = [];
    const result = await run(sponsoredSigner(KAI, { signed }), stage === "kind"
      ? { record: { status: 201, body: claim({ transaction_kind_bytes: "A" }) } }
      : { sponsor: { status: 200, body: { reservation_id: "res-1", transaction_bytes: "%not base64%", expires_at_ms: 9 } } });
    assert.deepEqual(result.outcome, { status: "failed", code: "mismatch" });
    assert.deepEqual(signed, []);
    assert.deepEqual(result.executed, []);
  }
});
