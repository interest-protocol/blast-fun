import assert from "node:assert/strict";
import test from "node:test";

import { bcs } from "@mysten/sui/bcs";
import { TransactionError, type SuiClientTypes } from "@mysten/sui/client";
import { fromBase64, normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";

import { evaluateSponsorPolicy } from "@blast/core/modules/sponsor/policy.ts";
import { claimedEventEntry, claimTestIdentity, executedClaim } from "../../../../test/fixtures/modules/social/claims/claim-fixtures.ts";
import { vestingClaimedEvents } from "@blast/core/modules/sponsor/linear-vesting.ts";
import { VESTING_PACKAGE } from "@blast/core/modules/vesting/model.ts";
import { claimChainFailure, claimedEvents, claimTransactionKind, claimVerdict, createClaimChain, vestingClaimTransactionKind } from "@blast/server/modules/social/claims/chain.ts";
import { openClaim } from "@blast/server/modules/social/claims/route.ts";

/**
 * R3-63's chain side without a network: the claim's transaction kind (the
 * SDK's `claim`, which the presale sponsor's own policy accepts for the
 * sender), the abort names, the `Claimed` events, the settlement verdict, the
 * Core API adapter over a stub client, and which positions are open.
 */

const identity = claimTestIdentity();
const PACKAGE = normalizeSuiAddress(identity.presale.packageId);
const SALE = `0x${"5a1e".padStart(64, "0")}`;
const KAI = `0x${"9a11e700".padStart(64, "0")}`;
const NOVA = `0x${"50fa".padStart(64, "0")}`;
const TOKEN = normalizeStructTag(`0x${"c0".padStart(64, "0")}::hlcn::HLCN`);
const USDC = normalizeStructTag("0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC");
const PRESALE = { objectId: SALE, initialSharedVersion: "4242", saleToken: TOKEN, quote: USDC };

test("R3-63: the claim's kind is one blast_presale::claim<S, Q>(presale, participant) the sponsor's claim intent accepts for its sender", async () => {
  const bytes = await claimTransactionKind(identity, PRESALE, KAI);
  const kind = bcs.TransactionKind.parse(bytes);
  const commands = kind.ProgrammableTransaction?.commands ?? [];
  assert.equal(commands.length, 1);
  const call = commands[0]?.MoveCall;
  assert.ok(call);
  assert.deepEqual(
    [normalizeSuiAddress(call.package), call.module, call.function, call.typeArguments.map((type) => normalizeStructTag(type))],
    [PACKAGE, "blast_presale", "claim", [TOKEN, USDC]],
  );
  const inputs = kind.ProgrammableTransaction!.inputs;
  const shared = inputs.find((input) => input.Object?.SharedObject)?.Object?.SharedObject;
  assert.deepEqual([normalizeSuiAddress(shared!.objectId), String(shared!.initialSharedVersion), shared!.mutable], [SALE, "4242", true]);
  const pure = inputs.find((input) => input.Pure)?.Pure;
  const raw: unknown = pure!.bytes;
  assert.equal(bcs.Address.parse(typeof raw === "string" ? fromBase64(raw) : Uint8Array.from(raw as ArrayLike<number>)), KAI);

  // The presale sponsor's own policy (intent `claim`) takes it from Kai, and refuses it from anyone else.
  const facts = { presalePackageId: PACKAGE, saleToken: TOKEN, quote: USDC, rewardRounds: [], swapTargets: [] };
  assert.deepEqual(evaluateSponsorPolicy({ kind, intent: "claim", presaleId: SALE, sender: KAI, facts }), { allowed: true });
  const other = evaluateSponsorPolicy({ kind, intent: "claim", presaleId: SALE, sender: NOVA, facts });
  assert.equal(other.allowed, false);
  // Built without a node: the same bytes every time.
  assert.deepEqual(await claimTransactionKind(identity, PRESALE, KAI), bytes);
});

test("R3-63: an abort is named only when the presale package raised it; gas and other failures get a label", () => {
  const abort = (pkg: string, module: string, code: number): SuiClientTypes.ExecutionError =>
    ({ $kind: "MoveAbort", message: "aborted", MoveAbort: { abortCode: String(code), location: { package: pkg, module } } }) as SuiClientTypes.ExecutionError;
  assert.deepEqual(claimChainFailure(abort(PACKAGE, "blast_presale", 20), identity), { moveAbort: "ENoCommitment", reason: "ENoCommitment" });
  assert.deepEqual(claimChainFailure(abort(PACKAGE, "blast_presale", 11), identity), { moveAbort: "EInvalidLifecycle", reason: "EInvalidLifecycle" });
  // A clever error's code wins over the raw abort code.
  const clever = {
    $kind: "MoveAbort",
    message: "aborted",
    MoveAbort: { abortCode: "9999999", location: { package: PACKAGE, module: "blast_presale" }, cleverError: { errorCode: 20 } },
  } as SuiClientTypes.ExecutionError;
  assert.equal(claimChainFailure(clever, identity).moveAbort, "ENoCommitment");
  // Another package reusing the module name is not the presale's abort (CL-19).
  assert.deepEqual(claimChainFailure(abort(`0x${"7".repeat(64)}`, "blast_presale", 20), identity), { moveAbort: null, reason: "external_abort" });
  assert.deepEqual(claimChainFailure(abort(PACKAGE, "blast_presale", 900), identity), { moveAbort: null, reason: "external_abort" });
  assert.deepEqual(
    claimChainFailure({ $kind: "InsufficientGas", message: "InsufficientGas" } as unknown as SuiClientTypes.ExecutionError, identity),
    { moveAbort: null, reason: "insufficient_gas" },
  );
  assert.deepEqual(claimChainFailure(null, identity), { moveAbort: null, reason: "unknown" });
});

test("R3-63: Claimed events are read from this deployment's package only; the verdict needs the wallet's own claim of that sale", () => {
  const ours = claimedEventEntry(identity, PRESALE, { presaleId: SALE, participant: KAI, quoteRefund: "250000000" });
  const elsewhere = { ...ours, eventType: ours.eventType.replace(PACKAGE, `0x${"7".repeat(64)}`) };
  const wrongModule = { ...ours, eventType: ours.eventType.replace("::events::", "::blast_presale::") };
  const garbage = { eventType: "not a type", bcs: new Uint8Array([1, 2]) };
  const events = claimedEvents([ours, elsewhere, wrongModule, garbage], identity);
  assert.deepEqual(events, [{ presaleId: SALE, participant: KAI, tokens: "0", quoteRefund: "250000000" }]);

  const claim = { presaleId: SALE, participant: KAI };
  assert.deepEqual(claimVerdict(claim, executedClaim({ sender: KAI, claims: events })), { state: "confirmed" });
  // Another wallet sent it: not this claim, whatever it did.
  assert.deepEqual(claimVerdict(claim, executedClaim({ sender: NOVA, claims: events })), { state: "failed", failureCode: "mismatch", moveAbort: null });
  // It aborted: execution_failed, naming the abort.
  assert.deepEqual(claimVerdict(claim, executedClaim({ sender: KAI, success: false, moveAbort: "ENoCommitment" })), {
    state: "failed",
    failureCode: "execution_failed",
    moveAbort: "ENoCommitment",
  });
  // It succeeded without paying Kai from this sale (another sale, another participant, no claim at all).
  for (const claims of [[], [{ ...events[0]!, presaleId: `0x${"1".repeat(64)}` }], [{ ...events[0]!, participant: NOVA }]]) {
    assert.deepEqual(claimVerdict(claim, executedClaim({ sender: KAI, claims })), { state: "failed", failureCode: "mismatch", moveAbort: null });
  }
});

test("P-13: a vesting claim is one pinned blast_fun_linear_vesting::claim the sponsor accepts for the beneficiary; its event settles it", async () => {
  const schedule = { objectId: `0x${"70".repeat(32)}`, initialSharedVersion: "12", coinType: TOKEN, beneficiary: normalizeSuiAddress(KAI) };
  const kind = bcs.TransactionKind.parse(await vestingClaimTransactionKind(schedule));
  const call = kind.ProgrammableTransaction!.commands[0]!.MoveCall!;
  assert.deepEqual([normalizeSuiAddress(call.package), call.module, call.function], [VESTING_PACKAGE, "blast_fun_linear_vesting", "claim"]);
  const facts = { presalePackageId: PACKAGE, saleToken: TOKEN, quote: USDC, rewardRounds: [], swapTargets: [], vestingSchedules: [schedule] };
  assert.deepEqual(evaluateSponsorPolicy({ kind, intent: "claim", presaleId: SALE, sender: KAI, facts }), { allowed: true });
  assert.equal(evaluateSponsorPolicy({ kind, intent: "claim", presaleId: SALE, sender: NOVA, facts }).allowed, false);

  const VestingClaimed = bcs.struct("VestingClaimed", {
    vesting_id: bcs.Address, coin_type: bcs.struct("TypeName", { name: bcs.string() }), beneficiary: bcs.Address, amount: bcs.u64(), released_total: bcs.u64(),
  });
  const event = {
    eventType: `${VESTING_PACKAGE}::blast_fun_linear_vesting::VestingClaimed`,
    bcs: VestingClaimed.serialize({ vesting_id: schedule.objectId, coin_type: { name: TOKEN.slice(2) }, beneficiary: KAI, amount: 5n, released_total: 5n }).toBytes(),
  };
  const lookalike = { ...event, eventType: event.eventType.replace(VESTING_PACKAGE, `0x${"7".repeat(64)}`) };
  const vestingClaims = vestingClaimedEvents([event, lookalike]);
  assert.deepEqual(vestingClaims, [{ vestingId: schedule.objectId, beneficiary: normalizeSuiAddress(KAI), coinType: normalizeStructTag(TOKEN) }]);
  const claim = { presaleId: SALE, participant: KAI, scheduleId: schedule.objectId };
  assert.deepEqual(claimVerdict(claim, executedClaim({ sender: KAI, vestingClaims })), { state: "confirmed" });
  // A presale claim's event does not settle a vesting claim, nor another schedule's.
  const presaleClaims = claimedEvents([claimedEventEntry(identity, PRESALE, { presaleId: SALE, participant: KAI })], identity);
  assert.equal(claimVerdict(claim, executedClaim({ sender: KAI, claims: presaleClaims })).state, "failed");
  assert.equal(claimVerdict({ ...claim, scheduleId: `0x${"71".repeat(32)}` }, executedClaim({ sender: KAI, vestingClaims })).state, "failed");

  // Nothing vested since the last claim: the vesting package's own clever error, by name.
  const nothing = {
    $kind: "MoveAbort",
    message: "aborted",
    MoveAbort: { abortCode: "13837028994300379151", location: { package: VESTING_PACKAGE, module: "blast_fun_linear_vesting" }, cleverError: { errorCode: 7 } },
  } as SuiClientTypes.ExecutionError;
  assert.deepEqual(claimChainFailure(nothing, identity), { moveAbort: "ENothingClaimable", reason: "ENothingClaimable" });
});

test("R3-63: the Core API adapter: the sale's object and types, a dry run with checks off as the wallet, the executed transaction", async () => {
  const objectType = `${PACKAGE}::blast_presale::Presale<${TOKEN}, ${USDC}>`;
  const calls: Record<string, unknown>[] = [];
  let objects: unknown[] = [{ objectId: SALE, type: objectType, owner: { $kind: "Shared", Shared: { initialSharedVersion: "4242" } } }];
  let simulated: unknown = { $kind: "Transaction", Transaction: { effects: { status: { success: true, error: null } } } };
  let transaction: unknown = null;
  const core = {
    async getObjects(options: Record<string, unknown>) {
      calls.push({ getObjects: options.objectIds });
      return { objects };
    },
    async simulateTransaction(options: Record<string, unknown>) {
      calls.push({ simulate: { checksEnabled: options.checksEnabled, sender: (options.transaction as { getData(): { sender: string } }).getData().sender } });
      return simulated;
    },
    async getTransaction(options: Record<string, unknown>) {
      calls.push({ getTransaction: options.digest, include: options.include });
      if (transaction === null) throw new TransactionError("notFound", String(options.digest));
      return transaction;
    },
  };
  const chain = createClaimChain({ client: { core } as never, identity });

  assert.deepEqual(await chain.presale(SALE), PRESALE);
  objects = [{ ...(objects[0] as object), type: `0x${"7".repeat(64)}::blast_presale::Presale<${TOKEN}, ${USDC}>` }];
  assert.equal(await chain.presale(SALE), null, "another package's Presale is not this deployment's");
  objects = [{ objectId: SALE, type: objectType, owner: { $kind: "AddressOwner", AddressOwner: KAI } }];
  assert.equal(await chain.presale(SALE), null, "an owned object is not a sale");
  objects = [new Error("notFound")];
  assert.equal(await chain.presale(SALE), null);

  const kind = await claimTransactionKind(identity, PRESALE, KAI);
  assert.deepEqual(await chain.simulate(kind, KAI), { status: "success" });
  simulated = {
    $kind: "FailedTransaction",
    FailedTransaction: {
      effects: { status: { success: false, error: { $kind: "MoveAbort", message: "x", MoveAbort: { abortCode: "20", location: { package: PACKAGE, module: "blast_presale" } } } } },
    },
  };
  assert.deepEqual(await chain.simulate(kind, KAI), { status: "failure", failure: { moveAbort: "ENoCommitment", reason: "ENoCommitment" } });
  assert.ok(calls.some((call) => JSON.stringify(call) === JSON.stringify({ simulate: { checksEnabled: false, sender: KAI } })));

  const DIGEST = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
  assert.equal(await chain.executed(DIGEST), null, "not found yet");
  const event = claimedEventEntry(identity, PRESALE, { presaleId: SALE, participant: KAI });
  transaction = {
    $kind: "Transaction",
    Transaction: {
      digest: DIGEST,
      timestampMs: 1_790_000_000_000,
      status: { success: true, error: null },
      effects: { status: { success: true, error: null } },
      events: [event],
      transaction: { sender: KAI },
    },
  };
  assert.deepEqual(await chain.executed(DIGEST), {
    success: true,
    sender: KAI,
    failure: null,
    claims: [{ presaleId: SALE, participant: KAI, tokens: "0", quoteRefund: "250000000" }],
    vestingClaims: [],
    creatorEvents: [],
    timestampMs: 1_790_000_000_000,
  });
  transaction = { $kind: "Transaction", Transaction: { ...(transaction as { Transaction: object }).Transaction, digest: "9GmKpXv3uRbT7wYc2LhNq5sDfE8jZa4oiP6Bt1Vy3nWx" } };
  assert.equal(await chain.executed(DIGEST), null, "an answer for another digest is not this one");
});

test("R3-63: a claim is open after a cancellation (refund) or a migration (tokens), with a commitment and no claim on chain", () => {
  const position = (lifecycle: string, over: Partial<{ commitment: string; claim_digest: string | null }> = {}) => ({
    lifecycle,
    commitment: "250000000",
    claim_digest: null,
    ...over,
  });
  assert.equal(openClaim(position("cancelled")), "claim_refund");
  assert.equal(openClaim(position("migrated")), "claim_tokens");
  for (const lifecycle of ["pending", "open", "funded"]) assert.equal(openClaim(position(lifecycle)), null, lifecycle);
  assert.equal(openClaim(position("cancelled", { claim_digest: "Pc1".padEnd(44, "1") })), null);
  assert.equal(openClaim(position("migrated", { commitment: "0" })), null);
  assert.equal(openClaim(null), null);
});
