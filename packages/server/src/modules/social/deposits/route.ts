import { routeSegments } from "@blast/core/modules/backend-api/route-path.ts";
import { SOCIAL_DEPOSIT_PATH } from "@blast/core/modules/backend-api/private/social-deposits-contracts.ts";
import { z } from "zod";
import { socialInput } from "@blast/server/modules/social/route-kit/validation.ts";
import { normalizeSuiAddress } from "@mysten/sui/utils";

import { recordMetric } from "@blast/core/lib/metrics.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { CircleIris } from "@blast/core/modules/presale/bridge/circle.ts";
import {
  BRIDGE_OPEN_REGISTRATIONS_PER_ACCOUNT,
  BRIDGE_OPEN_REGISTRATIONS_RETRY_AFTER_SECONDS,
  normalizeBridgeTxHash,
  type BridgeActivation,
  type BridgeTransfer,
  type BridgeTransfers,
} from "@blast/core/modules/presale/bridge/contracts.ts";
import { bridgeQuote, type BridgeEtaSeconds } from "@blast/core/modules/presale/bridge/quote.ts";
import { PresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";
import {
  socialDepositSubmissionSchema,
  SOCIAL_DEPOSIT_BRIDGE_ROUTE,
  SOCIAL_DEPOSIT_ROUTE,
  type SocialDeposit,
  type SocialDepositBridge,
  type SocialDepositClientFailure,
  type SocialDepositPlan,
  type SocialDepositSource,
  type SocialDepositTransfer,
} from "@blast/core/modules/social/contracts/deposits.ts";
import { atomsToUsd, PORTFOLIO_COIN_TYPES } from "@blast/core/modules/social/portfolio/read.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { readSocialJson, type SocialCaller, type SocialRequestContext, type SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import {
  logTransaction,
  TRANSACTION_COLUMNS,
  TransactionLogConflict,
  type TransactionEntry,
  type TransactionProgress,
  type TransactionRow,
} from "@blast/core/modules/social/transactions/log.ts";
import { depositPlan, depositTransferView, depositVerdict } from "@blast/server/modules/social/deposits/plan.ts";

/**
 * The deposit route (OA-25; contract in `contracts/deposits.ts`):
 * `PUT /api/social/me/deposits/{request_id}`, and the bridge's state for the
 * coins sheet, `GET /api/social/me/deposits`.
 *
 * The server builds what it can and the user signs the rest (R3-63's
 * pattern): it decides the route and the burn's every parameter for the
 * caller's Blast wallet, and logs the attempt before the source wallet is
 * asked to sign; the client only signs the burn on the source chain and
 * reports its hash. The attempt is settled from the presale bridge's own
 * transfer registry — what the relayer learned from Circle and the Sui mint
 * — never from anything the client says, so a deposit is `confirmed` only
 * when the attested burn minted exactly its amount to the Blast wallet.
 *
 * The log row's `tx_id` is the request id and its key
 * `deposit:<source>:<request id>`, so a later call is checked against the
 * source and amount it was recorded with. Nothing on the network runs inside
 * a database transaction.
 */

export type SocialDepositRouteDependencies = Readonly<{
  kit: SocialRouteKit;
  /** The primary (an owner sees what they just did). Resolved per request. */
  database: () => ReadableDatabase;
  /** The bridge's activation now: its latest record under this deployment's configuration. */
  activation: () => Promise<BridgeActivation>;
  /** Circle's fees and Fast allowance through the bridge's cached client (a failure is the presale's `bridge_unavailable`). */
  circle: CircleIris;
  /** The bridge's transfer registry: what the relayer tracks and settles. */
  transfers: Pick<BridgeTransfers, "register" | "find"> & {
    findByHash(source: SocialDepositSource, txHash: string): Promise<BridgeTransfer | null>;
    /** The Privy account's registrations Circle has not attested yet, counted up to `limit`. */
    openRegistrations(privyDid: string, limit: number): Promise<number>;
  };
  /** The caller's Blast wallet: a Privy session's embedded Sui wallet (null until it exists), a wallet session's own address. */
  blastWallet: (caller: SocialCaller) => Promise<string | null>;
  eta?: BridgeEtaSeconds;
}>;

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * The bridge registry needs a sale for every transfer (`presale_id NOT
 * NULL`), and a deposit into the Blast wallet is for none: Sui's zero
 * address says so. The column is an unauthenticated hint nothing on the
 * mint path reads (`BridgeTransfer.presaleId`).
 */
export const DEPOSIT_NO_PRESALE_ID = `0x${"0".repeat(64)}`;

/** The attempt by its id (the log's primary key). */
export const DEPOSIT_ROW_SQL = `SELECT ${TRANSACTION_COLUMNS} FROM social_transactions WHERE tx_id = $1::uuid`;

const USDC = PORTFOLIO_COIN_TYPES.usdc;

function requestIdOf(request: Request): string {
  const segment = routeSegments(SOCIAL_DEPOSIT_PATH, new URL(request.url).pathname)?.id ?? "";
  if (!z.string().regex(REQUEST_ID).safeParse(segment).success) throw new SocialRouteError("invalid_parameter");
  return segment;
}

type DepositInput = Readonly<{
  source: SocialDepositSource;
  amount: bigint;
  txHash: string | null;
  failure: SocialDepositClientFailure | null;
}>;

export const socialDepositRequestSchema = socialDepositSubmissionSchema.refine(
  (body) => body.tx_hash === undefined || normalizeBridgeTxHash(body.source, body.tx_hash) !== null,
);

/** The closed body: a source, a positive u64 of USDC atoms, and at most one hash or failure. */
function parseDeposit(body: unknown): DepositInput {
  const parsed = socialInput(socialDepositRequestSchema, body);
  return {
    source: parsed.source,
    amount: BigInt(parsed.amount),
    txHash: parsed.tx_hash === undefined ? null : normalizeBridgeTxHash(parsed.source, parsed.tx_hash),
    failure: parsed.failure ?? null,
  };
}

const keyOf = (source: SocialDepositSource, requestId: string) => `deposit:${source}:${requestId}`;

const isUniqueViolation = (error: unknown) =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";

/** The log entry a stored attempt was recorded with, so a later call repeats its facts exactly. */
function entryOf(row: TransactionRow): TransactionEntry {
  return {
    accountId: row.account_id,
    kind: row.kind,
    idempotencyKey: row.idempotency_key,
    txId: row.tx_id,
    presaleId: row.presale_id,
    coinType: row.coin_type,
    amount: row.amount,
    quoteType: row.quote_type,
    quoteAmount: row.quote_amount,
    usdValue: row.usd_value,
    createdAtMs: Number(row.created_at_ms),
  };
}

function depositBody(
  row: TransactionRow,
  source: SocialDepositSource,
  extra: Readonly<{ txHash?: string | null; transfer?: SocialDepositTransfer | null; plan?: SocialDepositPlan | null }> = {},
): SocialDeposit {
  const open = row.state === "submitted";
  return {
    request_id: row.tx_id,
    source,
    amount: row.amount ?? "0",
    state: row.state,
    digest: row.digest,
    failure_code: row.failure_code,
    tx_hash: extra.txHash ?? null,
    transfer: extra.transfer ?? null,
    plan: open && !extra.txHash ? (extra.plan ?? null) : null,
    created_at_ms: Number(row.created_at_ms),
    settled_at_ms: row.settled_at_ms === null ? null : Number(row.settled_at_ms),
  };
}

export function createSocialDepositRoutes(dependencies: SocialDepositRouteDependencies) {
  const { kit, database, activation, circle, transfers, blastWallet } = dependencies;

  const read = async (requestId: string): Promise<TransactionRow | null> =>
    (await database().read<TransactionRow>(DEPOSIT_ROW_SQL, [requestId])).rows[0] ?? null;

  /** Logs `progress` for the stored attempt; a row settled first by another call is answered as it now stands. */
  async function advance(context: SocialRequestContext, row: TransactionRow, progress: TransactionProgress): Promise<TransactionRow> {
    try {
      return await context.transaction(async (social) => (await logTransaction(social, entryOf(row), progress)).row, { label: "social.deposit" });
    } catch (error) {
      // Another attempt already holds this mint's digest.
      if (isUniqueViolation(error)) throw new SocialRouteError("deposit_conflict");
      if (!(error instanceof TransactionLogConflict)) throw error;
      if (error.reason !== "outcome") throw new SocialRouteError("deposit_conflict");
      return (await read(row.tx_id)) ?? row;
    }
  }

  /**
   * The burn to sign now: the bridge must be on, and Circle must list a
   * route from the source. Circle not answering is `service_unavailable`
   * (with its retry), never a guess at the fee.
   */
  async function plan(input: DepositInput, wallet: string): Promise<SocialDepositPlan> {
    const state = await activation();
    if (!state.active) {
      recordMetric("social.deposit", { step: "record", outcome: "deposit_unavailable", source: input.source, reason: state.reason });
      throw new SocialRouteError("deposit_unavailable");
    }
    let fees: Awaited<ReturnType<CircleIris["fees"]>>;
    let allowance: string;
    const requests: Promise<unknown>[] = [];
    try {
      const feeRequest = circle.fees(input.source);
      requests.push(feeRequest);
      const allowanceRequest = circle.fastAllowance();
      requests.push(allowanceRequest);
      [fees, allowance] = await Promise.all([feeRequest, allowanceRequest]);
    } catch (error) {
      if (error instanceof PresaleRouteError) {
        recordMetric("social.deposit", { step: "record", outcome: "circle_unavailable", source: input.source });
        throw new SocialRouteError("service_unavailable", { retryAfterSeconds: error.retryAfterSeconds ?? undefined });
      }
      throw error;
    } finally {
      await Promise.allSettled(requests);
    }
    const quote = bridgeQuote({ source: input.source, amount: input.amount, fees, allowanceUsdc: allowance, activation: state, eta: dependencies.eta });
    if (quote === null) {
      // Circle lists no Standard route to Sui from this source.
      recordMetric("social.deposit", { step: "record", outcome: "no_route", source: input.source });
      throw new SocialRouteError("deposit_unavailable");
    }
    const built = depositPlan(quote, input.amount, wallet);
    if (built === null) throw new SocialRouteError("invalid_amount");
    return built;
  }

  /** Step 1: build the burn for the Blast wallet, then log the attempt `submitted` before anything is signed. */
  async function record(context: SocialRequestContext, input: DepositInput, requestId: string, wallet: string, stored: TransactionRow | null): Promise<Response> {
    const accountId = context.account!.account_id;
    if (stored !== null && stored.state !== "submitted") return context.json(depositBody(stored, input.source), 200);
    const burn = await plan(input, wallet);
    if (stored !== null) return context.json(depositBody(stored, input.source, { plan: burn }), 200);
    const amount = input.amount.toString();
    const entry: TransactionEntry = {
      accountId,
      kind: "deposit",
      idempotencyKey: keyOf(input.source, requestId),
      txId: requestId,
      coinType: USDC,
      amount,
      // USDC is its own dollar value: the amount sent, not what lands after Circle's fee.
      usdValue: atomsToUsd(amount, 6, "1"),
    };
    let logged: Readonly<{ row: TransactionRow; outcome: string }>;
    try {
      logged = await context.transaction((social) => logTransaction(social, entry), { label: "social.deposit" });
    } catch (error) {
      // The same id raced in from another request, or was taken with other facts.
      if (isUniqueViolation(error) || error instanceof TransactionLogConflict) {
        const again = await read(requestId);
        if (again && again.account_id === accountId && again.idempotency_key === entry.idempotencyKey && again.amount === amount) {
          return context.json(depositBody(again, input.source, { plan: burn }), 200);
        }
        throw new SocialRouteError("deposit_conflict");
      }
      throw error;
    }
    recordMetric("social.deposit", { step: "record", outcome: "recorded", source: input.source, speed: burn.speed });
    return context.json(depositBody(logged.row, input.source, { plan: burn }), logged.outcome === "recorded" ? 201 : 200);
  }

  /** Step 2: the burn's hash — registered once with the bridge, then settled from what the bridge knows. */
  async function settle(
    context: SocialRequestContext,
    input: DepositInput & { txHash: string },
    stored: TransactionRow,
    wallet: string,
  ): Promise<Response> {
    const labels = { source: input.source };
    // A real burn is always registered, whatever the log says: registering is what lets the relayer mint it.
    let transfer = await transfers.findByHash(input.source, input.txHash);
    if (transfer === null) {
      const caller = context.caller!;
      // Review L6: a new registration makes the relayer poll Circle, so it counts per client IP, and a Privy
      // account may hold only a few that Circle has not attested yet. A repeat of a registered burn never counts.
      await context.consume("social_deposit_register");
      if (caller.kind === "privy"
        && (await transfers.openRegistrations(caller.did, BRIDGE_OPEN_REGISTRATIONS_PER_ACCOUNT)) >= BRIDGE_OPEN_REGISTRATIONS_PER_ACCOUNT) {
        recordMetric("social.deposit", { step: "register", outcome: "open_cap", ...labels });
        throw new SocialRouteError("rate_limited", { retryAfterSeconds: BRIDGE_OPEN_REGISTRATIONS_RETRY_AFTER_SECONDS });
      }
      const { id } = await transfers.register({
        source: input.source,
        txHash: input.txHash,
        suiAddress: normalizeSuiAddress(wallet),
        amount: input.amount.toString(),
        presaleId: DEPOSIT_NO_PRESALE_ID,
        privyDid: caller.kind === "privy" ? caller.did : null,
      });
      transfer = await transfers.find(id);
      if (transfer === null) throw new Error("A registered bridge transfer was not found.");
      recordMetric("social.deposit", { step: "register", outcome: "registered", ...labels });
    }
    const view = depositTransferView(transfer);
    if (stored.state !== "submitted") return context.json(depositBody(stored, input.source, { txHash: input.txHash, transfer: view }), 200);

    const verdict = depositVerdict(transfer, { source: input.source, blastWallet: wallet, amount: input.amount });
    if (verdict.state === "open") {
      return context.json(depositBody(stored, input.source, { txHash: input.txHash, transfer: view }), 202);
    }
    const progress: TransactionProgress =
      verdict.state === "confirmed"
        ? { state: "confirmed", digest: verdict.digest, settledAtMs: verdict.settledAtMs }
        : { state: "failed", digest: null, failureCode: verdict.failureCode, settledAtMs: verdict.settledAtMs ?? undefined };
    const settled = await advance(context, stored, progress);
    recordMetric("social.deposit", { step: "settle", outcome: verdict.state === "confirmed" ? "confirmed" : verdict.failureCode, ...labels });
    return context.json(depositBody(settled, input.source, { txHash: input.txHash, transfer: view }), 200);
  }

  /** Step 3: nothing was burned — the wallet declined, refused to send it, or the plan went unused. */
  async function fail(context: SocialRequestContext, input: DepositInput & { failure: SocialDepositClientFailure }, stored: TransactionRow): Promise<Response> {
    if (stored.state !== "submitted") {
      if (stored.failure_code === input.failure) return context.json(depositBody(stored, input.source), 200);
      throw new SocialRouteError("deposit_conflict");
    }
    const failed = await advance(context, stored, { state: "failed", digest: null, failureCode: input.failure });
    if (failed.state !== "failed" || failed.failure_code !== input.failure) throw new SocialRouteError("deposit_conflict");
    recordMetric("social.deposit", { step: "fail", outcome: input.failure, source: input.source });
    return context.json(depositBody(failed, input.source), 200);
  }

  async function handle(context: SocialRequestContext): Promise<Response> {
    const requestId = requestIdOf(context.request);
    const input = parseDeposit(await readSocialJson(context.request, ["source", "amount"], ["tx_hash", "failure"]));
    const accountId = context.account!.account_id;
    const wallet = await blastWallet(context.caller!);
    if (wallet === null) throw new SocialRouteError("blast_wallet_missing");

    const stored = await read(requestId);
    // Another account's id is not this caller's to read.
    if (stored !== null && stored.account_id !== accountId) throw new SocialRouteError("not_found");
    if (
      stored !== null &&
      (stored.kind !== "deposit" || stored.idempotency_key !== keyOf(input.source, requestId) || stored.amount !== input.amount.toString())
    ) {
      throw new SocialRouteError("deposit_conflict");
    }
    if (input.txHash !== null) {
      if (stored === null) throw new SocialRouteError("not_found");
      return settle(context, { ...input, txHash: input.txHash }, stored, wallet);
    }
    if (input.failure !== null) {
      if (stored === null) throw new SocialRouteError("not_found");
      return fail(context, { ...input, failure: input.failure }, stored);
    }
    return record(context, input, requestId, wallet, stored);
  }

  async function bridge(context: SocialRequestContext): Promise<Response> {
    const state = await activation();
    const body: SocialDepositBridge = { available: state.active };
    return context.json(body);
  }

  return Object.freeze({
    deposit: kit.route({ name: SOCIAL_DEPOSIT_ROUTE, auth: "account", account: "required", bucket: "social_deposit", cache: "private" }, handle),
    bridge: kit.route({ name: SOCIAL_DEPOSIT_BRIDGE_ROUTE, auth: "account", account: "required", bucket: "social_read", cache: "private" }, bridge),
  });
}

export type SocialDepositRoutes = ReturnType<typeof createSocialDepositRoutes>;
