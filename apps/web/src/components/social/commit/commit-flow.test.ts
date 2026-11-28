import assert from "node:assert/strict";
import test, { afterEach, beforeEach, mock } from "node:test";
import { fastTimeouts } from "../../../../test/fixtures/social/fast-timeouts.ts";
import { INTENT_REGISTER_TIMEOUT_MS } from "@blast/core/web/contracts/intents.ts";
beforeEach(() => fastTimeouts());
afterEach(() => mock.restoreAll());

import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";

import { commitOffLine, type SocialCommitBuild } from "@blast/core/modules/social/contracts/commit.ts";
import type { CommitSale } from "@blast/core/modules/social/commit/quote.ts";

import {
  COMMIT_BALANCE_CHANGED,
  COMMIT_BYTES_CHANGED,
  COMMIT_SALE_NOT_ON_SUI,
  COMMIT_SIGNATURE_REFUSED,
  COMMIT_SUI_UNREACHABLE,
  COMMIT_WALLET_BYTES_CHANGED,
  COMMIT_WALLET_NOT_READY,
  commitBuildRefusalMessage,
  commitRefusalMessage,
  runCommit,
  type CommitPhase,
  type CommitRequest,
} from "./commit-flow";
import type { SponsoredSigner } from "#web/components/social/sponsored-transaction.ts";
import { isSignatureRefusal, sponsoredWalletSigner } from "#web/lib/sui-signing.ts";
import { fetchViewerEntry, isSocialCommitBuild, registerIntentWithin } from "./commit-client";
import { runCommitFor } from "./commit-run";

/**
 * One blast end to end, with a mock transport (the commit route, the sponsor
 * and the intents route stubbed) and a mock signer (T-024-AC-3 / AC-096,
 * T-028-AC-5 / AC-092). The commit route itself is tested over Postgres in
 * `modules/social/commit/commits.integration.test.ts`.
 *
 * What it proves, and what nothing else can:
 *
 * - the browser builds nothing against the deployment: it asks
 *   `POST /api/social/me/commits` first, and signs only what that answered
 *   (sponsored: Blast pays the fee for every wallet);
 * - every refusal of the route is a named line, and nothing is sponsored,
 *   signed or executed after one;
 * - the intent is registered **after the digest is known and before execute**;
 * - a registration that hangs delays the execute by at most the published
 *   ceiling, and a `500` or a network failure does not stop it at all;
 * - a refused signature executes nothing;
 * - nothing is sponsored, signed or executed while blasting is off.
 */

const SENDER = `0x${"a1".repeat(32)}`;
const PRESALE = `0x${"ab".repeat(32)}`;
const USDC_TYPE = `0x${"db".repeat(32)}::usdc::USDC`;

/** A transaction that resolves entirely offline: it moves the gas coin to the sender. */
async function offlineCommit(budget = 10_000_000): Promise<Readonly<{ kind: Uint8Array; full: Uint8Array }>> {
  const transaction = new Transaction();
  transaction.setSender(SENDER);
  transaction.setGasPrice(1_000);
  transaction.setGasBudget(budget);
  transaction.setGasPayment([{ objectId: `0x${"11".repeat(32)}`, version: "7", digest: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi" }]);
  transaction.transferObjects([transaction.gas], transaction.pure.address(SENDER));
  const kind = await transaction.build({ onlyTransactionKind: true });
  const full = await transaction.build();
  return { kind, full };
}

type Call = Readonly<{ path: string; body: unknown; authorization: string | null; credentials: string | undefined }>;

/** The calls a blast makes, recorded in order, with per-path answers. */
function transport(answers: Readonly<Record<string, () => Promise<Response>>>) {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push({
      path,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      authorization: new Headers(init?.headers).get("authorization"),
      credentials: init?.credentials,
    });
    const key = Object.keys(answers).find((candidate) => path.startsWith(candidate));
    if (!key) throw new Error(`no answer for ${path}`);
    return answers[key]!();
  }) as typeof globalThis.fetch;
  return { calls, fetcher, paths: () => calls.map((call) => call.path) };
}

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const COMMITS = "/api/social/me/commits";
const INTENT = "/api/social/intents";
const SPONSOR = "/api/presale/sponsor";

/** The commit route's answer: the server's kind for the Blast wallet. */
function built(kind: Uint8Array, over: Partial<SocialCommitBuild> = {}): SocialCommitBuild {
  return {
    presale_id: PRESALE,
    sender: SENDER,
    fee: "sponsored",
    route: "open",
    quote_type: USDC_TYPE,
    amount: "50000000",
    transaction_kind_bytes: toBase64(kind),
    ...over,
  };
}

/** What the panel hands the flow for $50 of a USDC sale. */
const ORDER: CommitRequest["order"] = { payWith: "QUOTE", amount: "50000000" };

test("the server builds: the sponsored path asks the commit route, sponsors its kind, verifies, registers the digest, signs, then executes", async () => {
  const { kind, full } = await offlineCommit();
  const digest = TransactionDataBuilder.getDigestFromBytes(full);
  const order: string[] = [];
  const { fetcher, paths, calls } = transport({
    [COMMITS]: () => {
      order.push("build");
      return json(built(kind));
    },
    [`${SPONSOR}/`]: () => {
      order.push("execute");
      return json({ digest, effects: { status: "success", gas_used: "1000" } });
    },
    [SPONSOR]: () => json({ reservation_id: "r1", transaction_bytes: toBase64(full), sponsor_signature: "", expires_at_ms: 1, gas_budget: "1" }),
    [INTENT]: () => {
      order.push("intent");
      return json({ status: "recorded", why: "accepted" }, 201);
    },
  });
  const phases: CommitPhase[] = [];
  const signer: SponsoredSigner = {
    fee: "sponsored",
    address: SENDER,
    signTransaction: async () => {
      order.push("sign");
      return "sig";
    },
  };
  const result = await runCommit(
    { api: { getAccessToken: async () => null, fetch: fetcher }, signer, onPhase: (phase) => phases.push(phase) },
    { presaleId: PRESALE, order: ORDER, sourceEntryId: "a:12:0:0:0", why: "Great team, real product." },
  );
  assert.deepEqual(result, { status: "sent", digest, amount: "50000000", why: "accepted", registered: true });
  // The whole point of T-024: the registration is between the digest and the
  // signature, so the social layer knows the digest before the chain can.
  assert.deepEqual(order, ["build", "intent", "sign", "execute"]);
  assert.deepEqual(paths(), [COMMITS, SPONSOR, INTENT, `${SPONSOR}/r1/execute`]);
  assert.deepEqual(phases, ["preparing", "signing", "executing"]);
  // The route was asked for the commit, and the sponsor was given exactly the kind it answered.
  assert.deepEqual(calls[0]!.body, { presale_id: PRESALE, pay_with: "QUOTE", amount: "50000000" });
  assert.deepEqual(calls[1]!.body, { sender: SENDER, presale_id: PRESALE, transaction_kind_bytes: toBase64(kind), intent: "commit" });
  // Through the session helper: no Authorization without a token, the cookie (same-origin) instead (OA-16).
  assert.deepEqual(calls.map((call) => [call.authorization, call.credentials]), calls.map(() => [null, "same-origin"]));
});

test("a swap-and-commit the server already sponsored is verified, registered, signed and executed without asking the sponsor again", async () => {
  const { kind, full } = await offlineCommit();
  const digest = TransactionDataBuilder.getDigestFromBytes(full);
  const { fetcher, paths, calls } = transport({
    [COMMITS]: () => json(built(kind, { sponsored: { reservation_id: "r9", transaction_bytes: toBase64(full), expires_at_ms: 1 } })),
    [`${SPONSOR}/`]: () => json({ digest, effects: { status: "success", gas_used: "1000" } }),
    [SPONSOR]: () => { throw new Error("the public sponsor route admits no aggregator route"); },
    [INTENT]: () => json({ status: "recorded", why: null }, 201),
  });
  const signed: Uint8Array[] = [];
  const signer: SponsoredSigner = { fee: "sponsored", address: SENDER, signTransaction: async (bytes: Uint8Array) => { signed.push(bytes); return "sig"; } };
  const result = await runCommit(
    { api: { getAccessToken: async () => null, fetch: fetcher }, signer },
    { presaleId: PRESALE, order: { payWith: "QUOTE", amount: "50000000", swapQuoteId: "sealed-quote" } },
  );
  assert.equal(result.status, "sent");
  assert.deepEqual(paths(), [COMMITS, INTENT, `${SPONSOR}/r9/execute`]);
  assert.equal((calls[0]!.body as { swap_quote_id?: string }).swap_quote_id, "sealed-quote");
  assert.deepEqual(signed.map((bytes) => toBase64(bytes)), [toBase64(full)]);

  // The same kind sponsored for another sender is never signed or executed.
  const stranger = Transaction.fromKind(kind);
  stranger.setSender(`0x${"c3".repeat(32)}`);
  stranger.setGasPrice(1_000);
  stranger.setGasBudget(10_000_000);
  stranger.setGasPayment([{ objectId: `0x${"11".repeat(32)}`, version: "7", digest: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi" }]);
  const foreign = await stranger.build();
  const changed = transport({
    [COMMITS]: () => json(built(kind, { sponsored: { reservation_id: "r9", transaction_bytes: toBase64(foreign), expires_at_ms: 1 } })),
    [`${SPONSOR}/`]: () => { throw new Error("never executed"); },
    [INTENT]: () => json({ status: "recorded", why: null }, 201),
  });
  const refused = await runCommit(
    { api: { getAccessToken: async () => null, fetch: changed.fetcher }, signer },
    { presaleId: PRESALE, order: { payWith: "QUOTE", amount: "50000000", swapQuoteId: "sealed-quote" } },
  );
  assert.equal(refused.status, "failed");
  assert.deepEqual(changed.paths(), [COMMITS]);
  assert.equal(signed.length, 1);
});

test("T-024-AC-3: the registered intent carries the digest, the sale, the source item, the why, and what the server built", async () => {
  const { kind, full } = await offlineCommit();
  const digest = TransactionDataBuilder.getDigestFromBytes(full);
  const { fetcher, calls } = transport({
    [COMMITS]: () => json(built(kind)),
    [`${SPONSOR}/`]: () => json({ digest, effects: { status: "success", gas_used: "1" } }),
    [SPONSOR]: () => json({ reservation_id: "r1", transaction_bytes: toBase64(full), sponsor_signature: "", expires_at_ms: 1, gas_budget: "1" }),
    [INTENT]: () => json({ status: "recorded", why: "why_has_link" }, 201),
  });
  const signer: SponsoredSigner = { fee: "sponsored", address: SENDER, signTransaction: async () => "sig" };
  const result = await runCommit(
    { api: { getAccessToken: async () => "tok", fetch: fetcher }, signer },
    { presaleId: PRESALE, order: ORDER, sourceEntryId: "a:12:0:0:0", why: "see blast.fun", usdValue: "50.00" },
  );
  const intent = calls.find((call) => call.path === INTENT);
  assert.deepEqual(intent?.body, {
    action: "commit",
    presale_id: PRESALE,
    tx_digest: digest,
    transaction_bytes: toBase64(full),
    source_entry_id: "a:12:0:0:0",
    why: "see blast.fun",
    quote_type: USDC_TYPE,
    quote_amount: "50000000",
    usd_value: "50.00",
  });
  // A refused why is reported back and the commit still went through.
  assert.deepEqual(result, { status: "sent", digest, amount: "50000000", why: "why_has_link", registered: true });
  // A Privy token goes as the session helper's Bearer, never one built here (OA-16).
  assert.ok(calls.every((call) => call.authorization === "Bearer tok"));
});

test("T-024/R3-27: every commit registers, carrying the server's log facts, and an absent field is never invented", async () => {
  const { kind, full } = await offlineCommit();
  const digest = TransactionDataBuilder.getDigestFromBytes(full);
  const answers = {
    [COMMITS]: () => json(built(kind, { amount: "25000000" })),
    [`${SPONSOR}/`]: () => json({ digest, effects: { status: "success", gas_used: "1" } }),
    [SPONSOR]: () => json({ reservation_id: "r1", transaction_bytes: toBase64(full), sponsor_signature: "", expires_at_ms: 1, gas_budget: "1" }),
    [INTENT]: () => json({ status: "recorded", why: null }, 201),
  };
  const signer: SponsoredSigner = { fee: "sponsored", address: SENDER, signTransaction: async () => "sig" };
  // No why (a blank one is none), no source and no dollar value: the registration is still made,
  // because it is also the commit's transaction-log row (R3-27), with the coin and atoms the server built.
  const bare = transport(answers);
  const sent = await runCommit(
    { api: { getAccessToken: async () => null, fetch: bare.fetcher }, signer },
    { presaleId: PRESALE, order: { payWith: "QUOTE", amount: "25000000" }, why: "   " },
  );
  assert.deepEqual(sent, { status: "sent", digest, amount: "25000000", why: null, registered: true });
  assert.deepEqual(bare.paths(), [COMMITS, SPONSOR, INTENT, `${SPONSOR}/r1/execute`]);
  assert.deepEqual(bare.calls.find((call) => call.path === INTENT)?.body, {
    action: "commit",
    presale_id: PRESALE,
    tx_digest: digest,
    transaction_bytes: toBase64(full),
    quote_type: USDC_TYPE,
    quote_amount: "25000000",
  });
});

test("T-024-AC-3 (AC-096): a registration that hangs delays the execute by at most its ceiling", async () => {
  const { kind, full } = await offlineCommit();
  const digest = TransactionDataBuilder.getDigestFromBytes(full);
  let release!: () => void;
  const hang = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { fetcher } = transport({
    [COMMITS]: () => json(built(kind)),
    [`${SPONSOR}/`]: () => json({ digest, effects: { status: "success", gas_used: "1" } }),
    [SPONSOR]: () => json({ reservation_id: "r1", transaction_bytes: toBase64(full), sponsor_signature: "", expires_at_ms: 1, gas_budget: "1" }),
    [INTENT]: async () => {
      await hang;
      return new Response("{}", { status: 200 });
    },
  });
  const signer: SponsoredSigner = { fee: "sponsored", address: SENDER, signTransaction: async () => "sig" };
  const started = Date.now();
  const waits: number[] = [];
  fastTimeouts((ms) => waits.push(ms));
  try {
    const result = await runCommit(
      { api: { getAccessToken: async () => null, fetch: fetcher }, signer },
      { presaleId: PRESALE, order: ORDER, why: "waited" },
    );
    const elapsed = Date.now() - started;
    // It went through, with nothing claimed about the intent.
    assert.deepEqual(result, { status: "sent", digest, amount: "50000000", why: null, registered: false });
    assert.deepEqual(waits, [INTENT_REGISTER_TIMEOUT_MS]);
    assert.ok(elapsed < 2_000, `the commit waited ${elapsed} ms for a bounded registration`);
  } finally {
    release();
  }
});

test("T-024-AC-3 (AC-096): a 500, a malformed answer and a thrown request all still execute", async () => {
  for (const answer of [
    () => json({ error: { code: "service_unavailable", message: "x" } }, 500),
    () => json({ status: "weird" }, 201),
    () => Promise.reject(new Error("network down")),
  ]) {
    const { kind, full } = await offlineCommit();
    const digest = TransactionDataBuilder.getDigestFromBytes(full);
    const { fetcher, paths } = transport({
      [COMMITS]: () => json(built(kind)),
      [`${SPONSOR}/`]: () => json({ digest, effects: { status: "success", gas_used: "1" } }),
      [SPONSOR]: () => json({ reservation_id: "r1", transaction_bytes: toBase64(full), sponsor_signature: "", expires_at_ms: 1, gas_budget: "1" }),
      [INTENT]: answer,
    });
    const signer: SponsoredSigner = { fee: "sponsored", address: SENDER, signTransaction: async () => "sig" };
    const result = await runCommit(
      { api: { getAccessToken: async () => null, fetch: fetcher }, signer },
      { presaleId: PRESALE, order: ORDER, why: "x" },
    );
    assert.deepEqual(result, { status: "sent", digest, amount: "50000000", why: null, registered: false });
    assert.ok(paths().includes(`${SPONSOR}/r1/execute`));
  }
});

test("T-028-AC-5 (AC-092): a refused signature executes nothing, and nothing is asked for or built while blasting is off", async () => {
  const { kind, full } = await offlineCommit();
  const digest = TransactionDataBuilder.getDigestFromBytes(full);
  const { fetcher, paths } = transport({
    [COMMITS]: () => json(built(kind)),
    [`${SPONSOR}/`]: () => json({ digest, effects: { status: "success", gas_used: "1" } }),
    [SPONSOR]: () => json({ reservation_id: "r1", transaction_bytes: toBase64(full), sponsor_signature: "", expires_at_ms: 1, gas_budget: "1" }),
    [INTENT]: () => json({ status: "recorded", why: null }, 201),
  });
  const refuse: SponsoredSigner = {
    fee: "sponsored",
    address: SENDER,
    signTransaction: () => Promise.reject(Object.assign(new Error("User rejected the request"), { code: 4001 })),
  };
  const refused = await runCommit(
    { api: { getAccessToken: async () => null, fetch: fetcher }, signer: refuse },
    { presaleId: PRESALE, order: ORDER },
  );
  assert.deepEqual(refused, { status: "refused", message: `${COMMIT_SIGNATURE_REFUSED} Code: wallet_rejected.` });
  assert.ok(!paths().some((path) => path.endsWith("/execute")), "nothing executed");

  // Blasting off: not one call (not even the build), not one signature.
  const quiet = transport({});
  let signed = 0;
  const blocked = await runCommit(
    {
      api: { getAccessToken: async () => null, fetch: quiet.fetcher },
      signer: { fee: "sponsored", address: SENDER, signTransaction: async () => ((signed += 1), "sig") },
      blockers: ["presale_not_deployed"],
    },
    { presaleId: PRESALE, order: ORDER },
  );
  assert.deepEqual(blocked, { status: "blocked", reasons: ["presale_not_deployed"] });
  assert.deepEqual(quiet.paths(), []);
  assert.equal(signed, 0);
});

test("the server builds: every refusal of the commit route is a named line, and nothing is sponsored, signed or executed after it", async () => {
  const cases: [() => Promise<Response>, string][] = [
    // No PRESALE_DEPLOYMENT_MANIFEST naming a mainnet package on the server: the dialog's own off line, no crash.
    [() => json({ error: { code: "commit_unavailable", message: "x", reasons: ["presale_not_deployed"] } }, 409), `${commitOffLine(["presale_not_deployed"])} Code: commit_unavailable.`],
    [() => json({ error: { code: "insufficient_balance", message: "x" } }, 409), `${COMMIT_BALANCE_CHANGED} Code: insufficient_balance.`],
    [() => json({ error: { code: "not_found", message: "x" } }, 404), `${COMMIT_SALE_NOT_ON_SUI} Code: not_found.`],
    [() => json({ error: { code: "service_unavailable", message: "x" } }, 503), `${COMMIT_SUI_UNREACHABLE} Code: service_unavailable.`],
    [() => json({ error: { code: "blast_wallet_missing", message: "x" } }, 409), `${COMMIT_WALLET_NOT_READY} Code: blast_wallet_missing.`],
    [() => json({ error: { code: "rate_limited", message: "x" } }, 429), "Too many blasts for now. Nothing was sent. Try again later. Code: rate_limited."],
    [() => json({ error: { code: "unauthorized", message: "x" } }, 401), "Sign in again to blast. Code: unauthorized."],
    [() => json({ error: { code: "invalid_request", message: "x" } }, 400), "That didn’t go through. Nothing was sent. Code: invalid_request."],
    [() => json({ presale_id: PRESALE }), "The blast could not reach Blast. Nothing was sent. Try again. Code: invalid_response."],
    [() => Promise.reject(new TypeError("network down")), "The blast could not reach Blast. Nothing was sent. Try again. Code: network_unavailable."],
  ];
  for (const [answer, message] of cases) {
    const { fetcher, paths } = transport({ [COMMITS]: answer });
    let signed = 0;
    const result = await runCommit(
      {
        api: { getAccessToken: async () => null, fetch: fetcher },
        signer: { fee: "sponsored", address: SENDER, signTransaction: async () => ((signed += 1), "sig") },
      },
      { presaleId: PRESALE, order: ORDER },
    );
    assert.deepEqual(result, { status: "failed", message, digest: null, ...(message.includes("insufficient_balance") && { code: "insufficient_balance" }) });
    assert.deepEqual(paths(), [COMMITS]);
    assert.equal(signed, 0);
  }
  // The route's own codes keep the sentences the browser's build used to say; the rest are the flow's.
  assert.equal(commitBuildRefusalMessage({ status: "refused", code: "deployment_unavailable", retryAfterSeconds: null }), "Blasting is paused for a moment. Nothing was sent. Try again soon. Code: deployment_unavailable.");
  assert.equal(commitBuildRefusalMessage({ status: "refused", code: "commit_unavailable", retryAfterSeconds: null, reasons: ["swap_unavailable"] }), "A swap into this sale’s coin is unavailable or the quote changed. Refresh the quote or pay with the coin it raises in. Code: commit_unavailable.");
});

test("the server builds: a commit built for another wallet or another sale is never signed", async () => {
  const { kind } = await offlineCommit();
  for (const over of [{ sender: `0x${"b2".repeat(32)}` }, { presale_id: `0x${"cd".repeat(32)}` }]) {
    const { fetcher, paths } = transport({ [COMMITS]: () => json(built(kind, over)) });
    let signed = 0;
    const result = await runCommit(
      {
        api: { getAccessToken: async () => null, fetch: fetcher },
        signer: { fee: "sponsored", address: SENDER, signTransaction: async () => ((signed += 1), "sig") },
      },
      { presaleId: PRESALE, order: ORDER },
    );
    assert.deepEqual(result, { status: "failed", message: `${COMMIT_WALLET_NOT_READY} Code: request_failed.`, digest: null });
    assert.deepEqual(paths(), [COMMITS]);
    assert.equal(signed, 0);
  }
  // A well-formed answer is everything the flow reads; anything else is not a commit to sign.
  assert.ok(isSocialCommitBuild(built(kind)));
  for (const broken of [{ sender: "0x1" }, { fee: "free" }, { route: "private" }, { amount: "0" }, { transaction_kind_bytes: "not base64!" }, { quote_type: "USDC" }]) {
    assert.equal(isSocialCommitBuild({ ...built(kind), ...broken }), false, JSON.stringify(broken));
  }
});

test("T-028: bytes the sponsor or the wallet changed are never sent", async () => {
  const { kind, full } = await offlineCommit();
  // A different gas budget makes different bytes with the same commands.
  const other = await offlineCommit(20_000_000);
  const { fetcher, paths } = transport({
    [COMMITS]: () => json(built(kind)),
    [SPONSOR]: () => json({ reservation_id: "r1", transaction_bytes: toBase64(other.kind), sponsor_signature: "", expires_at_ms: 1, gas_budget: "1" }),
  });
  const sponsored = await runCommit(
    {
      api: { getAccessToken: async () => null, fetch: fetcher },
      signer: { fee: "sponsored", address: SENDER, signTransaction: async () => "sig" },
    },
    { presaleId: PRESALE, order: ORDER },
  );
  assert.deepEqual(sponsored, { status: "failed", message: `${COMMIT_BYTES_CHANGED} Code: invalid_response.`, digest: null });
  assert.deepEqual(paths(), [COMMITS, SPONSOR]);

  // A wallet session signs the sponsor's bytes; a wallet that signs other bytes sends nothing.
  const { fetcher: walletFetcher, paths: walletPaths } = transport({
    [COMMITS]: () => json(built(kind)),
    [SPONSOR]: () => json({ reservation_id: "r1", transaction_bytes: toBase64(full), sponsor_signature: "", expires_at_ms: 1, gas_budget: "1" }),
    [INTENT]: () => json({ status: "recorded", why: null }, 201),
  });
  const wallet = await runCommit(
    {
      api: { getAccessToken: async () => null, fetch: walletFetcher },
      signer: sponsoredWalletSigner({ fee: "wallet", address: SENDER, signTransaction: async () => ({ bytes: toBase64(other.full), signature: "sig" }) }),
    },
    { presaleId: PRESALE, order: ORDER },
  );
  assert.deepEqual(wallet, { status: "failed", message: `${COMMIT_WALLET_BYTES_CHANGED} Code: invalid_response.`, digest: null });
  assert.ok(!walletPaths().some((path) => path.endsWith("/execute")), "nothing executed");
});

test("T-028: a failed execute says what happened to the money, and every refusal has words", () => {
  assert.equal(commitRefusalMessage({ status: "error" }), "The blast could not reach Blast. Nothing was sent. Try again. Code: request_failed.");
  for (const code of ["deployment_unavailable", "deployment_mismatch", "pool_unavailable", "service_unavailable", "identity_unavailable"]) {
    assert.equal(commitRefusalMessage({ status: "refused", code, retryAfterSeconds: null }), `Blasting is paused for a moment. Nothing was sent. Try again soon. Code: ${code}.`);
  }
  assert.equal(commitRefusalMessage({ status: "refused", code: "not_eligible", retryAfterSeconds: null }), "You’re not on this sale’s allowlist. Nothing was sent. Code: not_eligible.");
  assert.equal(commitRefusalMessage({ status: "refused", code: "rate_limited", retryAfterSeconds: 30 }), "Too many blasts for now. Nothing was sent. Try again later. Code: rate_limited.");
  assert.equal(commitRefusalMessage({ status: "refused", code: "who_knows", retryAfterSeconds: null }), "That didn’t go through. Nothing was sent. Code: request_failed.");
  // A refusal is told apart from a failure by the wallet's own words.
  assert.ok(isSignatureRefusal(Object.assign(new Error("nope"), { code: 4001 })));
  assert.ok(isSignatureRefusal(new Error("User rejected the request")));
  assert.ok(isSignatureRefusal(new Error("Transaction was cancelled")));
  assert.ok(!isSignatureRefusal(new Error("Network error")));
  assert.ok(!isSignatureRefusal("nope"));
});

test("T-024-AC-3 (AC-096): the registration helper never throws and never waits past its ceiling", async () => {
  const slow = { getAccessToken: async () => null, fetch: (() => new Promise<Response>(() => undefined)) as typeof globalThis.fetch };
  const started = Date.now();
  assert.equal(await registerIntentWithin(slow, { presaleId: PRESALE, digest: "d" }), null);
  assert.ok(Date.now() - started < 2_000);
  const broken = { getAccessToken: async () => null, fetch: (() => Promise.reject(new Error("x"))) as typeof globalThis.fetch };
  assert.equal(await registerIntentWithin(broken, { presaleId: PRESALE, digest: "d" }), null);
  const thrown = {
    getAccessToken: () => Promise.reject(new Error("no token")),
    fetch: (() => Promise.reject(new Error("never called"))) as typeof globalThis.fetch,
  };
  assert.equal(await registerIntentWithin(thrown, { presaleId: PRESALE, digest: "d" }), null);
});

const MERIDIAN: CommitSale = {
  presaleId: PRESALE,
  name: "Meridian",
  symbol: "MRDN",
  lifecycle: "open",
  endMs: Number.MAX_SAFE_INTEGER,
  quoteCoin: "USDC",
  minCommitment: null,
  walletCap: null,
  allowlisted: true,
  raised: 0,
  target: 1,
  presalePrice: null,
};

test("T-028: an allowlisted sale without the wallet's leaf asks for and signs nothing", async () => {
  const quiet = transport({});
  const result = await runCommitFor({
    api: { getAccessToken: async () => null, fetch: quiet.fetcher },
    signer: { fee: "sponsored", address: SENDER, signTransaction: async () => "" },
    blockers: [],
    sale: MERIDIAN,
    input: { payWith: "USDC", pay: 50, usd: 50, quote: 50, why: "" },
    sourceEntryId: null,
    allowlist: null,
  });
  // The open route would abort on chain; without a leaf nothing is attempted.
  assert.deepEqual(result, { status: "failed", message: "You’re not on this sale’s allowlist. Nothing was sent. Code: not_eligible.", digest: null });
  assert.deepEqual(quiet.paths(), []);
});

test("the server builds: the panel's blast asks for its quote-coin atoms and the wallet's leaf, and logs its dollars", async () => {
  const { kind, full } = await offlineCommit();
  const digest = TransactionDataBuilder.getDigestFromBytes(full);
  const { fetcher, calls } = transport({
    [COMMITS]: () => json(built(kind, { route: "allowlisted", amount: "12345678" })),
    [`${SPONSOR}/`]: () => json({ digest, effects: { status: "success", gas_used: "1" } }),
    [SPONSOR]: () => json({ reservation_id: "r1", transaction_bytes: toBase64(full), sponsor_signature: "", expires_at_ms: 1, gas_budget: "1" }),
    [INTENT]: () => json({ status: "recorded", why: null }, 201),
  });
  const result = await runCommitFor({
    api: { getAccessToken: async () => null, fetch: fetcher },
    signer: { fee: "sponsored", address: SENDER, signTransaction: async () => "sig" },
    blockers: [],
    sale: MERIDIAN,
    input: { payWith: "USDC", pay: 12.345678, usd: 12.35, quote: 12.345678, why: "" },
    sourceEntryId: "a:12:0:0:0",
    allowlist: { index: 7n, wallet: SENDER, walletCap: 5_000_000_000n, proof: ["01".repeat(32)] },
  });
  assert.equal(result.status, "sent");
  // Atoms in the sale's quote coin (USDC: 6 decimals), and the leaf as the proof route answered it.
  assert.deepEqual(calls[0]!.body, {
    presale_id: PRESALE,
    pay_with: "QUOTE",
    amount: "12345678",
    allowlist: { index: "7", wallet_cap: "5000000000", proof: ["01".repeat(32)] },
  });
  const intent = calls.find((call) => call.path === INTENT)!.body as Record<string, unknown>;
  assert.deepEqual([intent.quote_amount, intent.usd_value, intent.source_entry_id], ["12345678", "12.35", "a:12:0:0:0"]);
});

test("T-028: the viewer's own position is the sale page's personal read, through the session helper", async () => {
  const VIEWER = "/api/social/presales/viewer";
  const mine = { commitment_usd: "500.00", commitment_atoms: "500000000", commits: [], claimed: false, refund_usd: null, refund_atoms: "0" };
  const { calls, fetcher } = transport({ [VIEWER]: () => json({ presales: { [PRESALE]: { following: [], following_total_usd: "0.00", following_total_atoms: "0", mine } }, rows: null }) });
  const read = await fetchViewerEntry({ getAccessToken: async () => null, fetch: fetcher }, PRESALE);
  assert.equal(read.status, "ok");
  assert.deepEqual(read.status === "ok" ? read.body?.mine : null, mine);
  assert.deepEqual(calls, [{ path: VIEWER, body: { presale_ids: [PRESALE] }, authorization: null, credentials: "same-origin" }]);
  // A sale the viewer never touched is no entry, and a refusal stays a refusal.
  const none = await fetchViewerEntry({ getAccessToken: async () => null, fetch: transport({ [VIEWER]: () => json({ presales: {}, rows: null }) }).fetcher }, PRESALE);
  assert.deepEqual(none, { status: "ok", httpStatus: 200, body: null });
  const refused = await fetchViewerEntry(
    { getAccessToken: async () => null, fetch: transport({ [VIEWER]: () => json({ error: { code: "account_required", message: "x" } }, 409) }).fetcher },
    PRESALE,
  );
  assert.equal(refused.status, "refused");
});

test("malformed commit kind and sponsor bytes fail before signing or executing", async () => {
  const { kind } = await offlineCommit();
  for (const stage of ["kind", "sponsor"]) {
    const signed: Uint8Array[] = [];
    const { fetcher, paths } = transport({
      [COMMITS]: () => json(built(kind, stage === "kind" ? { transaction_kind_bytes: "A" } : {})),
      [SPONSOR]: () => json({ reservation_id: "r1", transaction_bytes: "%not base64%", expires_at_ms: 1 }),
    });
    const result = await runCommit(
      { api: { getAccessToken: async () => null, fetch: fetcher }, signer: { fee: "sponsored", address: SENDER, signTransaction: async (bytes) => { signed.push(bytes); return "sig"; } } },
      { presaleId: PRESALE, order: ORDER },
    );
    assert.deepEqual(result, { status: "failed", message: `${COMMIT_BYTES_CHANGED} Code: invalid_response.`, digest: null });
    assert.deepEqual(signed, []);
    assert.ok(!paths().some((path) => path.endsWith("/execute")), "nothing executed");
  }
});

test("a direct payment in a different quote coin is refused before any request or signature", async () => {
  const quiet = transport({});
  const result = await runCommitFor({
    api: { getAccessToken: async () => null, fetch: quiet.fetcher },
    signer: { fee: "sponsored", address: SENDER, signTransaction: async () => assert.fail("must not sign") },
    blockers: [], sale: MERIDIAN, input: { payWith: "WAL", pay: 50, usd: 50, quote: 50, why: "" }, sourceEntryId: null, allowlist: null,
  });
  assert.equal(result.status, "failed");
  assert.deepEqual(quiet.paths(), []);
});

test("a sale whose end has passed sends nothing, even when the screen still showed it open", async () => {
  const quiet = transport({});
  const result = await runCommitFor({
    api: { getAccessToken: async () => null, fetch: quiet.fetcher },
    signer: { fee: "sponsored", address: SENDER, signTransaction: async () => assert.fail("must not sign") },
    blockers: [], sale: { ...MERIDIAN, allowlisted: false, endMs: Date.now() }, input: { payWith: "USDC", pay: 50, usd: 50, quote: 50, why: "" }, sourceEntryId: null, allowlist: null,
  });
  assert.deepEqual(result, { status: "failed", message: "This presale is not open for purchases. Nothing was sent. Code: commit_unavailable.", digest: null });
  assert.deepEqual(quiet.paths(), []);
});

test("an unconfirmed sponsored execution keeps its digest pending rather than inventing a failure", async () => {
  const { kind, full } = await offlineCommit();
  const digest = TransactionDataBuilder.getDigestFromBytes(full);
  const { fetcher } = transport({
    [COMMITS]: () => json(built(kind)),
    [`${SPONSOR}/`]: () => json({ error: { code: "execution_unconfirmed" } }, 503),
    [SPONSOR]: () => json({ reservation_id: "pending-commit", transaction_bytes: toBase64(full), expires_at_ms: Date.now() + 60_000 }),
    [INTENT]: () => json({}),
  });
  const signer: SponsoredSigner = { fee: "sponsored", address: SENDER, signTransaction: async () => "signature" };
  const result = await runCommit({ api: { getAccessToken: async () => null, fetch: fetcher }, signer }, { presaleId: PRESALE, order: ORDER });
  assert.equal(result.status, "pending");
  assert.equal("digest" in result && result.digest, digest);
  assert.match("message" in result ? result.message : "", /could not confirm.*Check.*before blasting again/s);
});

