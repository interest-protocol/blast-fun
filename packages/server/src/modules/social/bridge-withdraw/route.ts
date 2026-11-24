import { routeSegments } from "@blast/core/modules/backend-api/route-path.ts";
import { SOCIAL_BRIDGE_WITHDRAWAL_SETTLE_PATH } from "@blast/core/modules/backend-api/private/financial-contracts.ts";
import { claimWithdrawal, fenceWithdrawal, releaseWithdrawal, withdrawalRequestHash } from "./claims.ts";
import { z } from "zod";
import { socialInput } from "@blast/server/modules/social/route-kit/validation.ts";

import { TransactionError, type ClientWithCoreApi } from "@mysten/sui/client";
import { TransactionDataBuilder } from "@mysten/sui/transactions";
import { fromBase64, normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";

import { recordMetric } from "@blast/core/lib/metrics.ts";
import type { ModuleTransaction, ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { CircleWithdrawUnavailable, type CircleForwardFee, type CircleWithdrawIris } from "@blast/server/modules/presale/bridge/circle-withdraw.ts";
import { normalizeBridgeTxHash } from "@blast/core/modules/presale/bridge/contracts.ts";
import {
  burnMatches,
  canonicalWithdrawRecipient,
  depositForBurnEvents,
  forwardHookData,
  suiBurnTransaction,
  WITHDRAW_FINALITY_THRESHOLD,
  withdrawMintRecipient,
  type SuiBurnIds,
  type SuiBurnParams,
} from "@blast/core/modules/presale/bridge/sui-burn.ts";
import type { BridgeWithdrawGate } from "@blast/server/modules/presale/bridge/withdraw-activation.ts";
import {
  BRIDGE_WITHDRAW_DESTINATIONS,
  bridgeWithdrawMaxFee,
  isBridgeWithdrawDestination,
  SOCIAL_BRIDGE_WITHDRAW_QUOTE_ROUTE,
  SOCIAL_BRIDGE_WITHDRAW_ROUTE,
  SOCIAL_BRIDGE_WITHDRAW_SETTLE_ROUTE,
  type BridgeWithdrawDestination,
  type BridgeWithdrawUnavailableReason,
  type SocialBridgeNetworkFee,
  type SocialBridgeWithdrawal,
  type SocialBridgeWithdrawFailure,
  type SocialBridgeWithdrawOption,
  type SocialBridgeWithdrawQuote,
  type SocialBridgeWithdrawStatus,
} from "@blast/core/modules/social/contracts/bridge-withdraw.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { readSocialJson, type SocialCaller, type SocialRequestContext, type SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { simulationBytes, type TradeChain, type TradeSimulationResult } from "@blast/server/modules/social/trades/chain.ts";
import { sponsorAccountKey } from "@blast/server/modules/sponsor/caller.ts";
import type { PresaleSponsorService } from "@blast/server/modules/sponsor/service.ts";
import { expireUnsubmittedBridgeWithdrawal, KeyedSponsorRefusal } from "@blast/server/modules/sponsor/reservations.ts";
import { logTransaction, TransactionLogConflict, type TransactionEntry, type TransactionProgress } from "@blast/core/modules/social/transactions/log.ts";

/**
 * Withdraw to another chain (contract in `contracts/bridge-withdraw.ts`): the
 * reader's USDC burned on Sui with Circle's CCTP V2 for Circle's Forwarding
 * Service to mint on Base, Arbitrum, Ethereum or Solana. Modelled on the
 * swap path (`trades/swap.ts`, R3-31):
 *
 * - the server builds exactly the burn (`suiBurnTransaction`: the Blast
 *   wallet's own USDC, Circle's three calls, the Forwarding hook, no
 *   destination caller, Standard finality), dry-runs it, and records it once
 *   per idempotency key (`social_bridge_withdrawals`, migration 0100) and in
 *   the account's transaction log as `withdraw`;
 * - who pays the Sui network fee: Blast's gas pool, through the presale
 *   sponsor's in-process `bridge_withdraw` intent
 *   (`evaluateBridgeWithdrawPolicy`), for an embedded Blast wallet and a
 *   wallet session alike (owner ruling 2026-11-20 reversed OA-17); a sponsor
 *   refusal fails the withdrawal (`sponsor_refused`);
 * - a destination is offered only while the bridge's activation record proves
 *   it (`createBridgeWithdrawGate`), and Circle's fee is asked every time
 *   (cached): `max_fee` must be at least today's (`bridgeWithdrawMaxFee`) and
 *   below the amount. Circle keeps all of `max_fee`, so the reader receives
 *   `amount − max_fee` exactly, and that is what the sheet shows.
 *
 * Nothing here signs or executes. The browser checks the bytes, has the
 * wallet sign exactly them and executes them (the sponsor's execute route),
 * then asks the settle route: Sui by
 * the digest the server computed (`burned` once it executed as this burn),
 * then Circle by that digest (`delivered` once Circle reports its mint).
 */

/** What the settle route reads from Sui: whether the digest executed, and its events. */
export type ExecutedBurn = Readonly<{
  success: boolean;
  events: readonly Readonly<{ eventType: string; bcs: Uint8Array }>[];
}>;

export interface BurnLookup {
  /** The executed transaction, or null while the fullnode does not have it. Other failures reject. */
  executed(digest: string, signal?: AbortSignal): Promise<ExecutedBurn | null>;
}

/** The fullnode's view of an executed burn, for the settle route. */
export function fullnodeBurnLookup(client: () => Pick<ClientWithCoreApi, "core">): BurnLookup {
  return {
    async executed(digest, signal) {
      let result;
      try {
        result = await client().core.getTransaction({ digest, include: { effects: true, events: true }, signal });
      } catch (error) {
        if (error instanceof TransactionError && error.reason === "notFound") return null;
        throw error;
      }
      const transaction = result.Transaction ?? result.FailedTransaction;
      const effects = transaction?.effects;
      if (!transaction || !effects) return null;
      return {
        success: effects.status.success,
        events: (transaction.events ?? []).map((event) => ({ eventType: event.eventType, bcs: event.bcs })),
      };
    },
  };
}

export type BridgeWithdrawSponsor = Readonly<{
  recoverBridgeWithdrawal?: PresaleSponsorService["recoverBridgeWithdrawal"];
  sponsor(request: Parameters<PresaleSponsorService["sponsor"]>[0]): Promise<Pick<Awaited<ReturnType<PresaleSponsorService["sponsor"]>>, "reservation_id" | "transaction_bytes" | "expires_at_ms">>;
}>;

export type SocialBridgeWithdrawRoutesDependencies = Readonly<{
  kit: SocialRouteKit;
  /** The primary: withdrawals are personal and an owner sees what they just did. */
  database: () => ReadableDatabase;
  /** Which destinations the bridge's activation record proved, and the burn's ids. */
  gate: () => BridgeWithdrawGate;
  /** Circle's Iris for withdrawals, cached per process (`createCachedCircleWithdraw`). */
  circle: () => CircleWithdrawIris;
  /** The mainnet fullnode: the wallet's balances, the coins the burn spends, the dry runs. */
  chain: () => TradeChain;
  sponsor: () => BridgeWithdrawSponsor;
  /** The burn's ids from the deployment identity, for settling a burn built under them; null without them. */
  burnIds: () => SuiBurnIds | null;
  burns: () => BurnLookup;
  blastWallet: (caller: SocialCaller) => Promise<string | null>;
  now?: () => number;
}>;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const POSITIVE_ATOMS = /^[1-9][0-9]{0,19}$/;
const ATOMS = /^(0|[1-9][0-9]{0,19})$/;
const U64_MAX = 18_446_744_073_709_551_615n;
/** `wallet` labels rows built before every caller was sponsored. */
const FEE_LABELS = { blast: "Paid by Blast", wallet: "Paid from your SUI" } as const;
/** Blast's gas pool pays every caller's burn: an embedded wallet's and a wallet session's. */
const NETWORK_FEE: SocialBridgeNetworkFee = { payer: "blast", label: FEE_LABELS.blast };

/** One withdrawal as `social_bridge_withdrawals` holds it. */
export type BridgeWithdrawalRow = Readonly<{
  withdrawal_id: string;
  account_id: string;
  idempotency_key: string;
  sender: string;
  destination: BridgeWithdrawDestination;
  recipient: string;
  mint_recipient: string;
  amount: string;
  max_fee: string;
  hook: Buffer;
  fee_payer: "blast" | "wallet" | null;
  reservation_id: string | null;
  tx_bytes: Buffer | null;
  digest: string | null;
  expires_at_ms: string | null;
  state: SocialBridgeWithdrawStatus;
  failure_code: SocialBridgeWithdrawFailure | null;
  destination_tx_hash: string | null;
  created_at_ms: string;
  burned_at_ms: string | null;
  delivered_at_ms: string | null;
}>;

export const BRIDGE_WITHDRAWAL_COLUMNS = `withdrawal_id::text AS withdrawal_id, account_id::text AS account_id, idempotency_key, sender,
  destination, recipient, mint_recipient, amount::text AS amount, max_fee::text AS max_fee, hook, fee_payer,
  reservation_id::text AS reservation_id, tx_bytes, digest, expires_at_ms::text AS expires_at_ms, state, failure_code,
  destination_tx_hash, created_at_ms::text AS created_at_ms, burned_at_ms::text AS burned_at_ms,
  delivered_at_ms::text AS delivered_at_ms`;

export const BRIDGE_WITHDRAWAL_BY_KEY_SQL = `SELECT ${BRIDGE_WITHDRAWAL_COLUMNS} FROM social_bridge_withdrawals WHERE account_id = $1::uuid AND idempotency_key = $2`;
export const BRIDGE_WITHDRAWAL_BY_ID_SQL = `SELECT ${BRIDGE_WITHDRAWAL_COLUMNS} FROM social_bridge_withdrawals WHERE withdrawal_id = $1::uuid AND account_id = $2::uuid`;
const BRIDGE_WITHDRAWAL_LOCK_SQL = `${BRIDGE_WITHDRAWAL_BY_ID_SQL} FOR UPDATE`;

export const BRIDGE_WITHDRAWAL_INSERT_SQL = `INSERT INTO social_bridge_withdrawals (withdrawal_id, account_id, idempotency_key, sender, destination, recipient,
    mint_recipient, amount, max_fee, hook, fee_payer, reservation_id, tx_bytes, digest, expires_at_ms, state, failure_code, created_at_ms)
  VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::numeric, $9::numeric, $10, $11, $12::uuid, $13, $14, $15::bigint, $16, $17, $18::bigint)
  ON CONFLICT (account_id, idempotency_key) DO NOTHING
  RETURNING ${BRIDGE_WITHDRAWAL_COLUMNS}`;

const BRIDGE_WITHDRAWAL_BURNED_SQL = `UPDATE social_bridge_withdrawals SET state = $2, failure_code = $3,
    burned_at_ms = CASE WHEN $2::text = 'burned' THEN GREATEST($4::bigint, created_at_ms) ELSE NULL END
  WHERE withdrawal_id = $1::uuid AND state = 'built'
  RETURNING ${BRIDGE_WITHDRAWAL_COLUMNS}`;

const BRIDGE_WITHDRAWAL_DELIVERED_SQL = `UPDATE social_bridge_withdrawals SET state = 'delivered', destination_tx_hash = $2,
    delivered_at_ms = GREATEST($3::bigint, burned_at_ms)
  WHERE withdrawal_id = $1::uuid AND state = 'burned'
  RETURNING ${BRIDGE_WITHDRAWAL_COLUMNS}`;

/** The withdrawal as the routes answer it. */
export function bridgeWithdrawalBody(row: BridgeWithdrawalRow, at = Date.now()): SocialBridgeWithdrawal {
  return {
    withdrawal_id: row.withdrawal_id,
    status: row.state,
    destination: row.destination,
    recipient: row.recipient,
    amount: row.amount,
    max_fee: row.max_fee,
    receive: (BigInt(row.amount) - BigInt(row.max_fee)).toString(),
    network_fee: row.fee_payer === null ? null : { payer: row.fee_payer, label: FEE_LABELS[row.fee_payer] },
    reservation_id: row.reservation_id,
    // Freshness limits signing, never the retained chain settlement evidence.
    transaction_bytes: row.state === "built" && row.tx_bytes && row.expires_at_ms !== null && Number(row.expires_at_ms) > at ? toBase64(row.tx_bytes) : null,
    digest: row.digest,
    expires_at_ms: row.expires_at_ms === null ? null : Number(row.expires_at_ms),
    failure_code: row.failure_code,
    destination_tx_hash: row.destination_tx_hash,
    created_at_ms: Number(row.created_at_ms),
    burned_at_ms: row.burned_at_ms === null ? null : Number(row.burned_at_ms),
    delivered_at_ms: row.delivered_at_ms === null ? null : Number(row.delivered_at_ms),
  };
}

/** USDC atoms as US dollars with two places, rounded down (USDC is a dollar). */
export function usdcAtomsToUsd(atoms: string): string {
  const value = BigInt(atoms);
  return `${value / 1_000_000n}.${((value % 1_000_000n) / 10_000n).toString().padStart(2, "0")}`;
}

/** The withdrawal's row in the account's transaction log (R3-27): the USDC that leaves the Blast wallet. */
export function bridgeWithdrawalLogEntry(row: Pick<BridgeWithdrawalRow, "withdrawal_id" | "account_id" | "amount">, usdcType: string): TransactionEntry {
  return {
    accountId: row.account_id,
    kind: "withdraw",
    idempotencyKey: `bridge_withdraw:${row.withdrawal_id}`,
    txId: row.withdrawal_id,
    coinType: usdcType,
    amount: row.amount,
    usdValue: usdcAtomsToUsd(row.amount),
  };
}

/** Logs the withdrawal's progress in the same transaction as its own row; a key the log holds otherwise stands. */
async function logWithdrawal(social: ModuleTransaction<"social">, entry: TransactionEntry, progress: TransactionProgress): Promise<void> {
  try {
    await logTransaction(social, entry, progress);
  } catch (error) {
    if (!(error instanceof TransactionLogConflict)) throw error;
    recordMetric("social.bridge_withdraw", { step: "log", outcome: "conflict", reason: error.reason });
  }
}

function text(value: unknown, pattern: RegExp): string {
  return socialInput(z.string().regex(pattern), value);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
}

/** Circle's Standard-finality fee entry for the route, when Circle forwards there. */
function standardForward(fees: readonly CircleForwardFee[]): (CircleForwardFee & { forwardFee: NonNullable<CircleForwardFee["forwardFee"]> }) | null {
  const entry = fees.find((fee) => fee.finalityThreshold === WITHDRAW_FINALITY_THRESHOLD);
  return entry && entry.forwardFee ? (entry as CircleForwardFee & { forwardFee: NonNullable<CircleForwardFee["forwardFee"]> }) : null;
}

/** Whether a dry run executed. */
function dryRunPassed(result: TradeSimulationResult): boolean {
  const transaction = result.$kind === "Transaction" ? result.Transaction : result.FailedTransaction;
  return transaction?.effects?.status.success === true;
}

type Refusal = Extract<SocialBridgeWithdrawFailure, "insufficient_balance" | "dry_run_failed" | "sponsor_refused">;
type Built = Readonly<{ payer: "blast"; bytes: Uint8Array; reservationId: string; expiresAtMs: number }>;

/** What a replay must carry to be the same withdrawal. */
type Facts = Readonly<{ destination: BridgeWithdrawDestination; recipient: string; amount: bigint; maxFee: bigint }>;

/**
 * The withdrawal routes (contract in `contracts/bridge-withdraw.ts`):
 *
 * - `quote.GET`: account required, bucket `social_read`, `private, no-store`;
 * - `create.POST`: account required, bucket `social_bridge_withdraw`, `private, no-store`;
 * - `settle.POST`: account required, bucket `social_transfer`, `private, no-store`.
 */
export function createSocialBridgeWithdrawRoutes(dependencies: SocialBridgeWithdrawRoutesDependencies) {
  const { kit, database, blastWallet } = dependencies;
  const now = dependencies.now ?? Date.now;

  async function quote(context: SocialRequestContext): Promise<Response> {
    const state = await dependencies.gate().current();
    const off = (destination: BridgeWithdrawDestination, reason: BridgeWithdrawUnavailableReason): SocialBridgeWithdrawOption =>
      ({ destination, available: false, unavailable_reason: reason, fee_bps: null, forward_fee: null });
    const results = await Promise.allSettled(BRIDGE_WITHDRAW_DESTINATIONS.map(async (destination): Promise<SocialBridgeWithdrawOption> => {
      // Circle is asked only for a destination the activation record proved.
      if (!state.active || !state.live.includes(destination)) return off(destination, "not_live");
      let fees: readonly CircleForwardFee[];
      try {
        fees = await dependencies.circle().forwardFees(destination);
      } catch (error) {
        if (error instanceof CircleWithdrawUnavailable) return off(destination, "circle_unavailable");
        throw error;
      }
      const standard = standardForward(fees);
      if (!standard) return off(destination, "not_forwarded");
      return { destination, available: true, unavailable_reason: null, fee_bps: standard.minimumFeeBps, forward_fee: standard.forwardFee.high.toString() };
    }));
    const destinations = results.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    const body: SocialBridgeWithdrawQuote = { destinations, network_fee: NETWORK_FEE, as_of_ms: now() };
    return context.json(body);
  }

  async function readByKey(accountId: string, key: string): Promise<BridgeWithdrawalRow | null> {
    const { rows } = await database().read<BridgeWithdrawalRow>(BRIDGE_WITHDRAWAL_BY_KEY_SQL, [accountId, key]);
    return rows[0] ?? null;
  }

  /** A key already answered: its first answer, or `bridge_withdraw_conflict` for another withdrawal. */
  function replay(context: SocialRequestContext, row: BridgeWithdrawalRow, facts: Facts): Response {
    const same = row.destination === facts.destination
      && row.recipient === facts.recipient
      && BigInt(row.amount) === facts.amount
      && BigInt(row.max_fee) === facts.maxFee;
    if (!same) throw new SocialRouteError("bridge_withdraw_conflict", { extra: { withdrawal: bridgeWithdrawalBody(row, now()) } });
    recordMetric("social.bridge_withdraw", { step: "create", outcome: "replay", state: row.state });
    return context.json(bridgeWithdrawalBody(row, now()), 200);
  }

  /**
   * The burn, dry-run, then sponsored. A refusal names its code; a fullnode or
   * sponsor outage records no withdrawal. Retrying reuses a retained
   * reservation; an ambiguous budget attempt stays unavailable for reconciliation.
   */
  async function sponsoredBurn(kind: Uint8Array, sender: string, caller: SocialCaller, ip: string, signal: AbortSignal, reservationId: string): Promise<Built | Refusal> {
    try {
      // The sponsor counts this client IP, the account's daily share and the platform's cap after its dry run.
      const sponsored = await dependencies.sponsor().sponsor({ caller, presaleId: null, sender, kindBytes: kind, intent: "bridge_withdraw", ip, signal, reservationId });
      recordMetric("social.bridge_withdraw", { step: "sponsor", outcome: "reserved" });
      return { payer: "blast", bytes: fromBase64(sponsored.transaction_bytes), reservationId: sponsored.reservation_id, expiresAtMs: sponsored.expires_at_ms };
    } catch (error) {
      if (error instanceof KeyedSponsorRefusal) return "sponsor_refused";
      // The public answer is sanitized. A keyed reservation replays its bytes;
      // an ambiguous budget attempt remains unavailable rather than recounting.
      const code = (error as { code?: unknown }).code;
      const retry = (error as { retryAfterSeconds?: unknown }).retryAfterSeconds;
      recordMetric("social.bridge_withdraw", { step: "sponsor", outcome: "unavailable", code: code === undefined ? "error" : String(code) });
      throw new SocialRouteError("bridge_unavailable", typeof retry === "number" ? { retryAfterSeconds: retry } : {});
    }
  }

  async function build(ids: SuiBurnIds, sender: string, params: SuiBurnParams, caller: SocialCaller, ip: string, signal: AbortSignal, reservationId: string): Promise<Built | Refusal> {
    const chain = dependencies.chain();
    let kind: Uint8Array;
    try {
      if ((await chain.balance(sender, ids.usdcType, signal)) < params.amount) return "insufficient_balance";
      const price = await chain.referenceGasPrice(signal);
      kind = await suiBurnTransaction(ids, sender, params).build({ client: chain.client, onlyTransactionKind: true });
      // Exactly this burn, from the wallet's own USDC, on Sui as it is now (the fullnode's mocked gas coin pays).
      if (!dryRunPassed(await chain.simulate(simulationBytes({ kind, sender, gasOwner: sender, price }), signal))) return "dry_run_failed";
    } catch {
      recordMetric("social.bridge_withdraw", { step: "build", outcome: "fullnode_unavailable" });
      throw new SocialRouteError("service_unavailable");
    }
    return sponsoredBurn(kind, sender, caller, ip, signal, reservationId);
  }

  async function withdrawalInput(request: Request): Promise<{ key: string; facts: Facts }> {
    const body = await readSocialJson(request, ["idempotency_key", "destination", "recipient", "amount", "max_fee"]);
    const key = text(body.idempotency_key, UUID_V4);
    if (!isBridgeWithdrawDestination(body.destination)) throw new SocialRouteError("invalid_request");
    const destination = body.destination;
    const rawRecipient = socialInput(z.string().max(128), body.recipient);
    const amount = BigInt(text(body.amount, POSITIVE_ATOMS));
    const maxFee = BigInt(text(body.max_fee, ATOMS));
    if (amount > U64_MAX || maxFee > U64_MAX) throw new SocialRouteError("invalid_request");
    const recipient = canonicalWithdrawRecipient(destination, rawRecipient);
    if (recipient === null) throw new SocialRouteError("invalid_recipient");
    return { key, facts: { destination, recipient, amount, maxFee } };
  }

  async function currentBurn(destination: BridgeWithdrawDestination, amount: bigint, maxFee: bigint) {
    const state = await dependencies.gate().current();
    if (!state.active || !state.live.includes(destination)) {
      recordMetric("social.bridge_withdraw", { step: "create", outcome: "not_live", destination });
      throw new SocialRouteError("bridge_unavailable");
    }
    let fees: readonly CircleForwardFee[];
    try {
      fees = await dependencies.circle().forwardFees(destination);
    } catch (error) {
      if (!(error instanceof CircleWithdrawUnavailable)) throw error;
      throw new SocialRouteError("bridge_unavailable", { retryAfterSeconds: error.retryAfterSeconds });
    }
    const standard = standardForward(fees);
    if (!standard) throw new SocialRouteError("bridge_unavailable");
    const today = bridgeWithdrawMaxFee(amount, standard.minimumFeeBps, standard.forwardFee.high);
    if (today >= amount) throw new SocialRouteError("invalid_amount");
    if (maxFee < today) {
      recordMetric("social.bridge_withdraw", { step: "create", outcome: "fee_changed", destination });
      throw new SocialRouteError("bridge_fee_changed", { extra: { max_fee: today.toString() } });
    }

    return state;
  }

  async function prepareWithdrawal(
    context: SocialRequestContext,
    claim: Awaited<ReturnType<typeof claimWithdrawal>>,
    facts: Facts,
  ) {
    const { destination, recipient, amount, maxFee } = facts;
    const caller = context.caller!;
      const wallet = await blastWallet(caller);
      if (wallet === null) throw new SocialRouteError("blast_wallet_missing");
      const sender = normalizeSuiAddress(wallet);

      let refused = false;
      let retained: Awaited<ReturnType<PresaleSponsorService["recoverBridgeWithdrawal"]>> = null;
      try {
        retained = await dependencies.sponsor().recoverBridgeWithdrawal?.({ reservationId: claim.withdrawal_id, accountKey: sponsorAccountKey(caller), sender }) ?? null;
      } catch (error) {
        if (!(error instanceof KeyedSponsorRefusal)) throw new SocialRouteError("bridge_unavailable");
        refused = true;
      }
      const state = retained || refused ? null : await currentBurn(destination, amount, maxFee);
      const usdcType = state?.ids.usdcType ?? dependencies.burnIds()?.usdcType;
      if (!usdcType) throw new SocialRouteError("bridge_unavailable");

      const params: SuiBurnParams = {
        destination,
        amount,
        mintRecipient: await withdrawMintRecipient(destination, recipient),
        maxFee,
        hookData: forwardHookData(destination, recipient),
      };
      const signal = AbortSignal.any([context.request.signal, AbortSignal.timeout(60_000)]);
      const outcome: Built | Refusal = refused ? "sponsor_refused" : retained
        ? { payer: "blast", bytes: fromBase64(retained.transaction_bytes), reservationId: retained.reservation_id, expiresAtMs: retained.expires_at_ms }
        : await build(state!.ids, sender, params, caller, context.client.rateKey, signal, claim.withdrawal_id);

    return { sender, usdcType, params, outcome, retained };
  }

  async function create(context: SocialRequestContext): Promise<Response> {
    const { key, facts } = await withdrawalInput(context.request);
    const { destination, recipient, amount, maxFee } = facts;
    const accountId = context.account!.account_id;
    const caller = context.caller!;

    const existing = await readByKey(accountId, key);
    if (existing) return replay(context, existing, facts);
    // Circle keeps all of max_fee: a fee that takes the whole amount withdraws nothing.
    if (maxFee >= amount) throw new SocialRouteError("invalid_amount");

    const claim = await claimWithdrawal(context, key, withdrawalRequestHash(facts), now());
    try {
      const completed = await readByKey(accountId, key);
      if (completed) return replay(context, completed, facts);
      const { sender, usdcType, params, outcome, retained } = await prepareWithdrawal(context, claim, facts);

      const withdrawalId = claim.withdrawal_id;
      const createdAtMs = now();
      const built = typeof outcome === "string" ? null : outcome;
      const digest = built ? TransactionDataBuilder.getDigestFromBytes(built.bytes) : null;
      const values = [
        withdrawalId, accountId, key, sender, destination, recipient, params.mintRecipient, amount.toString(), maxFee.toString(),
        Buffer.from(params.hookData), built?.payer ?? null, built?.reservationId ?? null, built ? Buffer.from(built.bytes) : null, digest,
        built?.expiresAtMs ?? null, built ? "built" : "failed", built ? null : outcome, createdAtMs,
      ];
      let row: BridgeWithdrawalRow | null;
      try {
        row = await context.transaction(async (social, transaction) => {
          await fenceWithdrawal(social, claim, now());
          // Returned bytes always retain settlement. Only an absent ledger under
          // this claim fence can terminalize atomically with execute's state guard.
          if ((await social.read(BRIDGE_WITHDRAWAL_BY_KEY_SQL, [accountId, key])).rows[0]) return null;
          const expired =
            retained && retained.expires_at_ms <= now()
              ? await expireUnsubmittedBridgeWithdrawal(
                  transaction.forModule("presale-sponsor"),
                  { reservationId: retained.reservation_id, privyDid: sponsorAccountKey(caller), sender },
                  new Date(now()),
                )
              : false;
          const failure = expired ? "expired" : built ? null : outcome as Refusal;
          const finalValues = [...values];
          if (failure) { finalValues[15] = "failed"; finalValues[16] = failure; }
          const inserted = (await social.write<BridgeWithdrawalRow>("social_bridge_withdrawals", BRIDGE_WITHDRAWAL_INSERT_SQL, finalValues)).rows[0] ?? null;
          if (!inserted) return null;
          await logWithdrawal(
            social,
            { ...bridgeWithdrawalLogEntry(inserted, usdcType), createdAtMs },
            failure ? { state: "failed", digest, failureCode: failure, settledAtMs: createdAtMs } : { state: "submitted", digest },
          );
          return inserted;
        }, { label: "social.bridge_withdraw" });
      } catch (error) {
        // The same key twice at once: the first one's row answers.
        if (!isUniqueViolation(error)) throw error;
        row = null;
      }
      if (!row) {
        const first = await readByKey(accountId, key);
        if (!first) throw new SocialRouteError("service_unavailable");
        return replay(context, first, facts);
      }
      recordMetric("social.bridge_withdraw", { step: "create", outcome: row.state === "built" ? "built" : row.failure_code, payer: built?.payer ?? null, destination });
      return context.json(bridgeWithdrawalBody(row, now()), 201);
    } finally {
      // Failure after sponsorship is safe: its stable id replays the atomic
      // reservation and bytes; no fresh gas or quota reservation is requested.
      await releaseWithdrawal(context, claim, now()).catch(() => undefined);
    }
  }

  /** Built → burned or failed, from Sui by the digest; nothing known (an outage, not yet seen) changes nothing. */
  async function settleBurn(context: SocialRequestContext, row: BridgeWithdrawalRow): Promise<BridgeWithdrawalRow> {
    const ids = dependencies.burnIds();
    if (ids === null || row.digest === null) return row;
    let executed: ExecutedBurn | null;
    try {
      executed = await dependencies.burns().executed(row.digest, context.request.signal);
    } catch {
      recordMetric("social.bridge_withdraw", { step: "settle", outcome: "lookup_failed" });
      return row;
    }
    const at = now();
    let state: "burned" | "failed";
    let failure: SocialBridgeWithdrawFailure | null = null;
    // Local signing freshness cannot prove that retained transaction bytes never executed.
    if (!executed) return row;
    if (executed.success) {
      const matches = burnMatches(depositForBurnEvents(executed.events, ids), {
        sender: row.sender,
        destination: row.destination,
        amount: BigInt(row.amount),
        mintRecipient: row.mint_recipient,
        maxFee: BigInt(row.max_fee),
        hookData: Uint8Array.from(row.hook),
      });
      state = matches ? "burned" : "failed";
      failure = matches ? null : "mismatch";
    } else {
      state = "failed";
      failure = "execution_failed";
    }
    const settled = await context.transaction(async (social) => {
      const locked = (await social.read<BridgeWithdrawalRow>(BRIDGE_WITHDRAWAL_LOCK_SQL, [row.withdrawal_id, row.account_id])).rows[0];
      if (!locked || locked.state !== "built") return locked ?? null;
      const updated = (await social.write<BridgeWithdrawalRow>("social_bridge_withdrawals", BRIDGE_WITHDRAWAL_BURNED_SQL, [row.withdrawal_id, state, failure, at])).rows[0]!;
      await logWithdrawal(
        social,
        bridgeWithdrawalLogEntry(updated, ids.usdcType),
        state === "burned"
          ? { state: "confirmed", digest: updated.digest!, settledAtMs: at }
          : { state: "failed", digest: executed ? updated.digest : null, failureCode: failure!, settledAtMs: at },
      );
      return updated;
    }, { label: "social.bridge_withdraw_settle" });
    recordMetric("social.bridge_withdraw", { step: "settle", outcome: state === "burned" ? "burned" : failure, destination: row.destination });
    return settled ?? row;
  }

  /** Burned → delivered, once Circle reports its mint on the destination with that transaction's hash. */
  async function settleDelivery(context: SocialRequestContext, row: BridgeWithdrawalRow): Promise<BridgeWithdrawalRow> {
    if (row.digest === null) return row;
    let message;
    try {
      message = await dependencies.circle().message(row.digest);
    } catch {
      // Circle could not be asked: nothing changes, and the next settle asks again.
      return row;
    }
    if (message?.forwardState !== "COMPLETE" || message.forwardTxHash === null) return row;
    const hash = normalizeBridgeTxHash(row.destination, message.forwardTxHash);
    if (hash === null) return row;
    const at = now();
    const delivered = await context.transaction(async (social) => {
      const updated = await social.write<BridgeWithdrawalRow>("social_bridge_withdrawals", BRIDGE_WITHDRAWAL_DELIVERED_SQL, [row.withdrawal_id, hash, at]);
      return updated.rows[0] ?? null;
    }, { label: "social.bridge_withdraw_delivered" });
    if (delivered) recordMetric("social.bridge_withdraw", { step: "settle", outcome: "delivered", destination: row.destination });
    return delivered ?? row;
  }

  async function settle(context: SocialRequestContext): Promise<Response> {
    const withdrawalId = routeSegments(SOCIAL_BRIDGE_WITHDRAWAL_SETTLE_PATH, new URL(context.request.url).pathname)?.withdrawal_id ?? "";
    if (!z.string().regex(UUID).safeParse(withdrawalId).success) throw new SocialRouteError("invalid_parameter");
    const accountId = context.account!.account_id;
    const { rows } = await database().read<BridgeWithdrawalRow>(BRIDGE_WITHDRAWAL_BY_ID_SQL, [withdrawalId, accountId]);
    let row = rows[0];
    if (!row) throw new SocialRouteError("not_found");
    if (row.state === "built") row = await settleBurn(context, row);
    // Sui attests a burn in about a second: one settle may see it burned and Circle's mint.
    if (row.state === "burned") row = await settleDelivery(context, row);
    return context.json(bridgeWithdrawalBody(row, now()));
  }

  return Object.freeze({
    quote: Object.freeze({
      GET: kit.route({ name: SOCIAL_BRIDGE_WITHDRAW_QUOTE_ROUTE, auth: "account", account: "required", bucket: "social_read", cache: "private" }, quote),
    }),
    create: Object.freeze({
      POST: kit.route({ name: SOCIAL_BRIDGE_WITHDRAW_ROUTE, auth: "account", account: "required", bucket: "social_bridge_withdraw", cache: "private" }, create),
    }),
    settle: Object.freeze({
      POST: kit.route({ name: SOCIAL_BRIDGE_WITHDRAW_SETTLE_ROUTE, auth: "account", account: "required", bucket: "social_transfer", cache: "private" }, settle),
    }),
  });
}

export type SocialBridgeWithdrawRoutes = ReturnType<typeof createSocialBridgeWithdrawRoutes>;
