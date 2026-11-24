import { routeSegments } from "@blast/core/modules/backend-api/route-path.ts";
import { SOCIAL_TRADE_SETTLE_PATH } from "@blast/core/modules/backend-api/private/social-trades-contracts.ts";
import { z } from "zod";
import { socialInput } from "@blast/server/modules/social/route-kit/validation.ts";

import { createHash, randomUUID } from "node:crypto";

import { TransactionError, type ClientWithCoreApi } from "@mysten/sui/client";
import { type Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { fromBase64, normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";

import { recordMetric } from "@blast/core/lib/metrics.ts";
import type { ModuleTransaction, ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { SponsorKindRequest } from "@blast/server/modules/sponsor/service.ts";
import type { SocialConfig } from "@blast/core/modules/social/contracts/config.ts";
import {
  socialTradeInputSchema,
  SOCIAL_TRADE_BASE_COINS,
  walletTradeGasBudget,
  type SocialTradeBalanceFailure,
  SOCIAL_TRADE_ROUTE,
  SOCIAL_TRADE_SETTLE_ROUTE,
  type SocialTrade,
  type SocialTradeFailure,
  type SocialTradeHop,
  type SocialTradeSide,
} from "@blast/core/modules/social/contracts/trades.ts";
import { atomsToUsd } from "@blast/core/modules/social/portfolio/read.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { readSocialJson, type SocialCaller, type SocialRequestContext, type SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { logTransaction, TransactionLogConflict, type TransactionEntry, type TransactionProgress } from "@blast/core/modules/social/transactions/log.ts";
import type { TradeRouter } from "@blast/server/modules/social/trades/aggregator.ts";
import { routeLabel, venueOf } from "@blast/core/modules/social/trades/amounts.ts";
import { dryRunVerdict, minimumOutFailed, simulationBytes, swapKind, swapTransaction, type TradeChain } from "@blast/server/modules/social/trades/chain.ts";
import { readTradeCoins } from "@blast/server/modules/social/trades/coins.ts";
import { openTradeQuote, type SealedTradeQuote } from "@blast/server/modules/social/trades/quote-token.ts";
import { filledOut, recordSwapReceipt } from "./receipts.ts";
export { filledOut } from "./receipts.ts";

/**
 * The swap path (social feed R3-31): a trade the quote service offered
 * (R3-30's sealed `quote_id`), built over **that route's pools in that order**
 * for the caller's own Blast wallet to sign, with the minimum in the
 * transaction itself (the aggregator's swap context aborts below it), and
 * recorded once per idempotency key (`social_swap_intents`, migration 0089)
 * and in the account's transaction log (R3-27) as `trade_buy` / `trade_sell`.
 *
 * Who pays the network fee (OA-25 Q12; owner ruling 2026-11-20 reversed
 * OA-17): Blast's gas pool, for an embedded Blast wallet and a wallet session
 * alike, up to `trade_sponsor_daily_cap` sponsored trades per account a UTC
 * day, through the presale sponsor's in-process `trade` intent. Past the cap, or with the sponsor down, the
 * route answers `sponsorship_unavailable` with the fee, and the same request
 * with `accept_fee` builds a trade the wallet pays for: never a refusal to
 * trade.
 *
 * Blast's app fee (`BLAST_TRADE_FEE_BPS`) is in the swap itself: the
 * aggregator's swap context names its rate and receiver and splits it off the
 * output coin on chain. The quote's rate is sealed in its `quote_id`; a quote
 * sealed at another rate than the router charges now is `quote_expired`.
 * What the trade filled is still the sender's own balance change.
 *
 * Nothing here signs or executes. The browser signs the returned bytes with
 * the wallet (Privy's embedded key, or Slush) and executes them — through the
 * sponsor's existing `POST /api/presale/sponsor/{reservation_id}/execute` for
 * a sponsored trade, on the fullnode for one the wallet pays — then asks the
 * settle route, which reads the outcome from the chain by the digest the
 * server computed from the bytes it built.
 */

/** What the settle route reads from mainnet: an executed transaction by digest. */
export type ExecutedTrade = Readonly<{
  success: boolean;
  /** Null until the transaction belongs to a checkpoint. */
  timestampMs?: number | null;
  checkpoint?: string | null;
  sender: string;
  balanceChanges: readonly Readonly<{ coinType: string; address: string; amount: string }>[];
  /** Signed net gas, MIST (computation + storage − rebate). */
  gasMist: bigint;
  /** The abort's location and code, when it aborted. */
  abort: Readonly<{ packageId: string | null; module: string | null; code: number | null }> | null;
  /** The chain rejected a payout below the absolute minimum. */
  minimumOutFailed?: boolean;
}>;

export interface TradeLookup {
  /** The executed transaction, or null while the fullnode does not have it (not found yet). Other failures reject. */
  executed(digest: string, signal?: AbortSignal): Promise<ExecutedTrade | null>;
}

/** The fullnode's view of an executed transaction, for the settle route. */
export function fullnodeTradeLookup(client: () => Pick<ClientWithCoreApi, "core">): TradeLookup {
  return {
    async executed(digest, signal) {
      let result;
      try {
        result = await client().core.getTransaction({ digest, include: { effects: true, balanceChanges: true, transaction: true }, signal });
      } catch (error) {
        if (error instanceof TransactionError && error.reason === "notFound") return null;
        throw error;
      }
      const transaction = result.Transaction ?? result.FailedTransaction;
      const sender = transaction?.transaction?.sender;
      const effects = transaction?.effects;
      if (!transaction || !effects || typeof sender !== "string") return null;
      const used = effects.gasUsed;
      const gas = BigInt(used.computationCost) + BigInt(used.storageCost) - BigInt(used.storageRebate);
      const error = effects.status.error;
      const abort = error?.$kind === "MoveAbort"
        ? {
          packageId: error.MoveAbort.location?.package ? normalizeSuiAddress(error.MoveAbort.location.package) : null,
          module: error.MoveAbort.location?.module ?? null,
          code: typeof error.MoveAbort.cleverError?.errorCode === "number"
            ? error.MoveAbort.cleverError.errorCode
            : /^[0-9]{1,15}$/.test(error.MoveAbort.abortCode) ? Number(error.MoveAbort.abortCode) : null,
        }
        : null;
      return {
        success: effects.status.success,
        timestampMs: transaction.timestampMs,
        checkpoint: transaction.checkpoint,
        sender,
        balanceChanges: transaction.balanceChanges ?? [],
        gasMist: gas,
        abort,
        minimumOutFailed: minimumOutFailed(error, () => transaction.transaction?.kind.ProgrammableTransaction?.commands),
      };
    },
  };
}

/** The in-process presale sponsor's one call the swap path makes (`createSponsorService`). */
export type TradeSponsor = Readonly<{
  sponsor(request: SponsorKindRequest): Promise<Readonly<{ reservation_id: string; transaction_bytes: string; expires_at_ms: number }>>;
}>;

export type SocialSwapRoutesDependencies = Readonly<{
  kit: SocialRouteKit;
  /** The primary: trades are personal and an owner sees what they just did. */
  database: () => ReadableDatabase;
  router: () => TradeRouter;
  chain: () => TradeChain;
  /** The `quote_id` key (R3-30). */
  quoteKey: () => Buffer;
  sponsor: () => TradeSponsor;
  config: () => Promise<SocialConfig>;
  transactions: () => TradeLookup;
  blastWallet: (caller: SocialCaller) => Promise<string | null>;
  now?: () => number;
}>;

/** How long a wallet-paid trade's bytes are ours to settle: the sponsor's reservation life (120 s − 10 s). */
export const WALLET_TRADE_TTL_MS = 110_000;
/** Past `expires_at_ms`, how long the settle route still looks for the digest before calling it expired. */
export const TRADE_SETTLE_GRACE_MS = 60_000;
/** A wallet-paid trade's gas budget: the dry run's gas × 1.2, within these bounds (the sponsor's). */
export const TRADE_MAX_GAS_BUDGET_MIST = 50_000_000n;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FEE_LABELS = { blast: "Paid by Blast", wallet: "Paid from your SUI" } as const;
const SUI = SOCIAL_TRADE_BASE_COINS.sui;

/** One trade as `social_swap_intents` holds it. */
export type TradeRow = Readonly<{
  trade_id: string;
  account_id: string;
  idempotency_key: string;
  quote_digest: Buffer;
  side: SocialTradeSide;
  sender: string;
  in_coin: string;
  out_coin: string;
  amount_in: string;
  amount_out: string;
  min_out: string;
  slippage_bps: number;
  route: readonly SocialTradeHop[];
  route_label: string | null;
  usd_value: string | null;
  fee_payer: "blast" | "wallet" | null;
  reservation_id: string | null;
  tx_bytes: Buffer | null;
  digest: string | null;
  expires_at_ms: string | null;
  state: SocialTrade["status"];
  failure_code: SocialTradeFailure | null;
  balance_failure?: SocialTradeBalanceFailure | null;
  amount_out_filled: string | null;
  created_at_ms: string;
  settled_at_ms: string | null;
}>;

export const TRADE_COLUMNS = `trade_id::text AS trade_id, account_id::text AS account_id, idempotency_key, quote_digest, side, sender,
  in_coin, out_coin, amount_in::text AS amount_in, amount_out::text AS amount_out, min_out::text AS min_out, slippage_bps,
  route, route_label, usd_value::text AS usd_value, fee_payer, reservation_id::text AS reservation_id, tx_bytes, digest,
  expires_at_ms::text AS expires_at_ms, state, failure_code, balance_failure, amount_out_filled::text AS amount_out_filled,
  created_at_ms::text AS created_at_ms, settled_at_ms::text AS settled_at_ms`;

/** The key's trade, by the `(account_id, idempotency_key)` unique index. */
export const TRADE_BY_KEY_SQL = `SELECT ${TRADE_COLUMNS} FROM social_swap_intents WHERE account_id = $1::uuid AND idempotency_key = $2`;
/** One trade of the account, by its primary key, locked for its settlement. */
export const TRADE_LOCK_SQL = `SELECT ${TRADE_COLUMNS} FROM social_swap_intents WHERE trade_id = $1::uuid AND account_id = $2::uuid FOR UPDATE`;
/**
 * The trades Blast sponsored for the account since `$2` (the UTC day's start),
 * by the partial index, counted up to `$3` (the cap): the answer only has to
 * say whether the cap is reached, so no account's history costs more than
 * the cap's rows. A trade that failed on chain counts, since Blast's sponsor
 * paid its gas (review L2); only one that never landed (`expired`) does not.
 * Curve reservations share the cap; swap reservations already in the ledger count once.
 * A reservation is keyed by the caller's `sponsorAccountKey`: one of the
 * account's Privy DIDs, or `sui:<address>` for a wallet session signed in with
 * any address the account holds.
 */
export const TRADE_SPONSORED_SINCE_SQL = `SELECT count(*)::int AS sponsored FROM (
    SELECT 1 FROM social_swap_intents
    WHERE account_id = $1::uuid AND fee_payer = 'blast' AND failure_code IS DISTINCT FROM 'expired' AND created_at_ms >= $2
    UNION ALL
    SELECT 1 FROM presale_sponsor_reservations r
    WHERE r.intent = 'trade' AND r.created_at >= to_timestamp($2::double precision / 1000)
      AND r.state NOT IN ('reservation_failed', 'expired')
      AND (r.submitted_at IS NOT NULL OR r.expires_at > to_timestamp($4::double precision / 1000))
      AND r.privy_did IN (
        SELECT a.privy_did FROM social_accounts a WHERE a.account_id = $1::uuid
        UNION
        SELECT i.provider_subject FROM social_accounts a
        JOIN mission_control_account_identities i ON i.profile_id = a.profile_id AND i.provider = 'privy'
        WHERE a.account_id = $1::uuid
        UNION
        SELECT 'sui:' || a.sui_address FROM social_accounts a WHERE a.account_id = $1::uuid AND a.sui_address IS NOT NULL
        UNION
        SELECT 'sui:' || w.address FROM social_account_wallets w WHERE w.account_id = $1::uuid
        UNION
        SELECT 'sui:' || w.sui_address FROM social_accounts a
        JOIN mission_control_account_wallets w ON w.profile_id = a.profile_id
        WHERE a.account_id = $1::uuid
      )
      AND NOT EXISTS (SELECT 1 FROM social_swap_intents s WHERE s.reservation_id = r.id)
    LIMIT $3
  ) sponsored`;

export const TRADE_INSERT_SQL = `INSERT INTO social_swap_intents (trade_id, account_id, idempotency_key, quote_digest, side, sender, in_coin, out_coin,
    amount_in, amount_out, min_out, slippage_bps, route, route_label, quote_expires_at_ms, usd_value, fee_payer, reservation_id, tx_bytes,
    digest, expires_at_ms, state, failure_code, created_at_ms, settled_at_ms, balance_failure)
  VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::numeric, $10::numeric, $11::numeric, $12, $13::jsonb, $14, $15, $16::numeric, $17,
    $18::uuid, $19, $20, $21::bigint, $22::text, $23, $24::bigint, CASE WHEN $22::text = 'built' THEN NULL ELSE $24::bigint END, $25::jsonb)
  ON CONFLICT (account_id, idempotency_key) DO NOTHING
  RETURNING ${TRADE_COLUMNS}`;

export const TRADE_SETTLE_SQL = `UPDATE social_swap_intents SET state = $2, failure_code = $3, amount_out_filled = $4::numeric,
    settled_at_ms = GREATEST($5::bigint, created_at_ms)
  WHERE trade_id = $1::uuid AND state = 'built'
  RETURNING ${TRADE_COLUMNS}`;

/** The start of `nowMs`'s UTC day. */
export function utcDayStartMs(nowMs: number): number {
  return nowMs - (nowMs % 86_400_000);
}

/** The account's sponsored trades today, counted up to `limit`. */
export async function sponsoredToday(db: ReadableDatabase, accountId: string, nowMs: number, limit: number): Promise<number> {
  const { rows } = await db.read<{ sponsored: number }>(TRADE_SPONSORED_SINCE_SQL, [accountId, utcDayStartMs(nowMs), limit, nowMs]);
  return Number(rows[0]?.sponsored ?? 0);
}

/**
 * Who would pay an account's next trade's fee (the quote's `network_fee`,
 * R3-30, refined): Blast for a signed-in caller (a Privy session's embedded
 * wallet or a wallet session) while the account is under today's cap, the
 * wallet otherwise.
 */
export async function tradeFeePayer(
  db: ReadableDatabase,
  config: SocialConfig,
  caller: Readonly<{ kind: "privy" | "wallet" | null; accountId: string | null }>,
  nowMs: number,
): Promise<"blast" | "wallet"> {
  if (caller.kind === null || caller.accountId === null || config.trade_sponsor_daily_cap <= 0) return "wallet";
  const cap = config.trade_sponsor_daily_cap;
  return (await sponsoredToday(db, caller.accountId, nowMs, cap)) < cap ? "blast" : "wallet";
}

/** The trade as the routes answer it. */
export function tradeBody(row: TradeRow): SocialTrade {
  return {
    trade_id: row.trade_id,
    status: row.state,
    side: row.side,
    in_coin: row.in_coin,
    out_coin: row.out_coin,
    amount_in: row.amount_in,
    amount_out: row.amount_out,
    min_out: row.min_out,
    amount_out_filled: row.amount_out_filled,
    route_label: row.route_label,
    network_fee: row.fee_payer === null ? null : { payer: row.fee_payer, label: FEE_LABELS[row.fee_payer] },
    reservation_id: row.reservation_id,
    // The bytes are only worth signing while the trade is built.
    transaction_bytes: row.state === "built" && row.tx_bytes ? toBase64(row.tx_bytes) : null,
    digest: row.digest,
    expires_at_ms: row.expires_at_ms === null ? null : Number(row.expires_at_ms),
    failure_code: row.failure_code,
    ...(row.balance_failure ? { balance_failure: row.balance_failure } : {}),
    created_at_ms: Number(row.created_at_ms),
    settled_at_ms: row.settled_at_ms === null ? null : Number(row.settled_at_ms),
  };
}

/** The trade's row in the account's transaction log (R3-27): what it gets and what it gives. */
export function tradeLogEntry(row: Pick<TradeRow, "trade_id" | "account_id" | "idempotency_key" | "side" | "in_coin" | "out_coin" | "amount_in" | "amount_out" | "usd_value">): TransactionEntry {
  return {
    accountId: row.account_id,
    kind: row.side === "buy" ? "trade_buy" : "trade_sell",
    idempotencyKey: `trade:${row.idempotency_key}`,
    txId: row.trade_id,
    coinType: row.out_coin,
    amount: row.amount_out,
    quoteType: row.in_coin,
    quoteAmount: row.amount_in,
    usdValue: row.usd_value,
  };
}

/** Logs the trade's progress in the same transaction as its own row; a key the log holds otherwise stands. */
async function logTrade(social: ModuleTransaction<"social">, row: TradeRow, progress: TransactionProgress): Promise<void> {
  try {
    await logTransaction(social, tradeLogEntry(row), progress);
  } catch (error) {
    if (!(error instanceof TransactionLogConflict)) throw error;
    recordMetric("social.trade", { step: "log", outcome: "conflict", reason: error.reason });
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
}

type RefusalCode = Extract<SocialTradeFailure, "quote_expired" | "price_moved" | "insufficient_balance" | "pool_unavailable">;
type Refusal = RefusalCode | Readonly<{ code: "insufficient_balance"; balanceFailure: SocialTradeBalanceFailure }>;

function shortBalance(reason: SocialTradeBalanceFailure["reason"], coinType: string, required: bigint, available: bigint): Refusal {
  return { code: "insufficient_balance", balanceFailure: { reason, coin_type: coinType, required_atoms: required.toString(), available_atoms: available.toString() } };
}

/** A swap ending that is not a trade answer: the fee prompt, carried to the route's error. */
class FeeRequired extends Error {
  readonly feeMist: bigint;
  constructor(feeMist: bigint) {
    super("sponsorship unavailable");
    this.feeMist = feeMist;
  }
}

/**
 * The trade routes of R3-31 (contract in `contracts/trades.ts`):
 *
 * - `create.POST` (`POST /api/social/trades`): account required, bucket
 *   `social_intent`, `private, no-store`;
 * - `settle.POST` (`POST /api/social/trades/{trade_id}/settle`): account
 *   required, bucket `social_transfer`, `private, no-store`.
 */
export function createSocialSwapRoutes(dependencies: SocialSwapRoutesDependencies) {
  const { kit, database, blastWallet } = dependencies;
  const now = dependencies.now ?? Date.now;

  async function readByKey(accountId: string, key: string): Promise<TradeRow | null> {
    const { rows } = await database().read<TradeRow>(TRADE_BY_KEY_SQL, [accountId, key]);
    return rows[0] ?? null;
  }

  /** A key already answered: its first answer, or `trade_conflict` for another quote. */
  function replay(context: SocialRequestContext, row: TradeRow, quoteDigest: Buffer): Response {
    if (!Buffer.from(row.quote_digest).equals(quoteDigest)) throw new SocialRouteError("trade_conflict", { extra: { trade: tradeBody(row) } });
    recordMetric("social.trade", { step: "create", outcome: "replay", state: row.state });
    return context.json(tradeBody(row), 200);
  }

  type Built = Readonly<{
    payer: "blast" | "wallet";
    bytes: Uint8Array;
    reservationId: string | null;
    expiresAtMs: number;
  }>;

  function preparationFacts(outcome: Built | Refusal) {
    if (typeof outcome === "string") return { built: null, refusal: outcome, balanceFailure: null };
    if ("code" in outcome) return { built: null, refusal: outcome.code, balanceFailure: outcome.balanceFailure };
    return { built: outcome, refusal: null, balanceFailure: null };
  }

  /**
   * The pinned swap, dry-run, then built for the payer: the route's legs in
   * the quote's order with its amounts and slippage, nothing re-routed. A
   * refusal names its code; the fee prompt throws `FeeRequired`.
   */
  async function buildWalletSwap(quote: SealedTradeQuote, chain: TradeChain, router: TradeRouter, held: bigint, price: bigint, gas: bigint, signal: AbortSignal): Promise<Built | Refusal> {
    const sender = quote.sender;
    const swap = { router, route: quote.route, sender, inCoin: quote.inCoin, slippageBps: quote.slippageBps };
    // The wallet pays: a SUI input may come from the gas coin, and the budget is the dry run's gas × 1.2.
    const budget = walletTradeGasBudget(gas);
    if (budget > TRADE_MAX_GAS_BUDGET_MIST) return "pool_unavailable";
    let bytes: Uint8Array;
    try {
      const suiHeld = quote.inCoin === SUI ? held : await chain.balance(sender, SUI, signal);
      const required = budget + (quote.inCoin === SUI ? quote.amountIn : 0n);
      if (suiHeld < required) return shortBalance("gas", SUI, required, suiHeld);
      const tx: Transaction = await swapTransaction({ ...swap, useGasCoin: quote.inCoin === SUI });
      tx.setGasOwner(sender);
      tx.setGasPrice(price);
      tx.setGasBudget(budget);
      bytes = await tx.build({ client: chain.client });
      const verdict = dryRunVerdict(await chain.simulate(bytes, signal), {
        aggregatorPackage: quote.route.aggregatorPackage,
        sender,
        outCoin: quote.outCoin,
      }, bytes);
      if (verdict.status === "failed") {
        return verdict.failure === "slippage" ? "price_moved" : verdict.failure === "insufficient" ? "insufficient_balance" : "pool_unavailable";
      }
    } catch {
      return "pool_unavailable";
    }
    return { payer: "wallet", bytes, reservationId: null, expiresAtMs: now() + WALLET_TRADE_TTL_MS };
  }

  async function sponsoredSwap(quote: SealedTradeQuote, caller: SocialCaller, kind: Uint8Array, ip: string, signal: AbortSignal, gas: bigint, acceptFee: boolean): Promise<Built | null> {
    const sender = quote.sender;
    try {
      // The sponsor counts this client IP, the account's daily share and the platform's cap after its dry run.
      const sponsored = await dependencies.sponsor().sponsor({
        caller,
        presaleId: null,
        sender,
        kindBytes: kind,
        intent: "trade",
        ip,
        signal,
      });
      recordMetric("social.trade", { step: "sponsor", outcome: "reserved" });
      return { payer: "blast", bytes: fromBase64(sponsored.transaction_bytes), reservationId: sponsored.reservation_id, expiresAtMs: sponsored.expires_at_ms };
    } catch (error) {
      // The sponsor refused or is down (its code is the sponsor's, never shown): the wallet may pay instead.
      recordMetric("social.trade", { step: "sponsor", outcome: "unavailable", code: (error as { code?: unknown }).code === undefined ? "error" : String((error as { code?: unknown }).code) });
      if (!acceptFee) throw new FeeRequired(gas);
      return null;
    }
  }

  async function fundedSwap(quote: SealedTradeQuote, caller: SocialCaller, accountId: string, acceptFee: boolean, ip: string, signal: AbortSignal, kind: Uint8Array, gas: bigint): Promise<Built | null> {
    if ((await tradeFeePayer(database(), await dependencies.config(), { kind: caller.kind, accountId }, now())) !== "blast") {
      if (!acceptFee) throw new FeeRequired(gas);
      return null;
    }
    return sponsoredSwap(quote, caller, kind, ip, signal, gas, acceptFee);
  }

  async function build(
    quote: SealedTradeQuote,
    caller: SocialCaller,
    accountId: string,
    acceptFee: boolean,
    ip: string,
    signal: AbortSignal,
  ): Promise<Built | Refusal> {
    const chain = dependencies.chain();
    const router = dependencies.router();
    const sender = quote.sender;
    const swap = { router, route: quote.route, sender, inCoin: quote.inCoin, slippageBps: quote.slippageBps };
    let held: bigint;
    let price: bigint;
    let kind: Uint8Array;
    try {
      held = await chain.balance(sender, quote.inCoin, signal);
      if (held < quote.amountIn) return shortBalance("input", quote.inCoin, quote.amountIn, held);
      price = await chain.referenceGasPrice(signal);
      kind = await swapKind({ ...swap, useGasCoin: false }, chain.client);
    } catch {
      return "pool_unavailable";
    }
    // The dry run of exactly the pinned swap: below the quote's own minimum it aborts in the swap context.
    let gas: bigint;
    try {
      const bytes = simulationBytes({ kind, sender, gasOwner: sender, price });
      const verdict = dryRunVerdict(await chain.simulate(bytes, signal), {
        aggregatorPackage: quote.route.aggregatorPackage,
        sender,
        outCoin: quote.outCoin,
      }, bytes);
      if (verdict.status === "failed") {
        return verdict.failure === "slippage" ? "price_moved" : verdict.failure === "insufficient" ? "insufficient_balance" : "pool_unavailable";
      }
      gas = verdict.gasMist;
    } catch {
      return "pool_unavailable";
    }

    const sponsored = await fundedSwap(quote, caller, accountId, acceptFee, ip, signal, kind, gas);
    if (sponsored) return sponsored;

    return buildWalletSwap(quote, chain, router, held, price, gas, signal);
  }

  async function swapInput(request: Request) {
    const body = await readSocialJson(request, ["quote_id", "amount_in", "min_out", "idempotency_key"], ["accept_fee"]);
    const parsed = socialInput(socialTradeInputSchema, body);
    const { quote_id: quoteId, amount_in: amountIn, min_out: minOutText, idempotency_key: key } = parsed;
    const acceptFee = parsed.accept_fee === true;
    return { quoteId, amountIn, minOutText, key, acceptFee };
  }

  async function boundQuote(quoteId: string, accountId: string, amountIn: string, minOutText: string, caller: SocialCaller): Promise<SealedTradeQuote> {
    const quote = openTradeQuote(dependencies.quoteKey(), quoteId);
    if (!quote || quote.accountId !== accountId) throw new SocialRouteError("invalid_request");
    if (quote.amountIn.toString() !== amountIn || quote.minOut.toString() !== minOutText) throw new SocialRouteError("invalid_request");
    const wallet = await blastWallet(caller);
    if (wallet === null) throw new SocialRouteError("blast_wallet_missing");
    if (normalizeSuiAddress(wallet) !== normalizeSuiAddress(quote.sender)) throw new SocialRouteError("invalid_request");

    return quote;
  }

  async function buildCurrentQuote(quote: SealedTradeQuote, blastFeeBps: number, createdAtMs: number, caller: SocialCaller, accountId: string, acceptFee: boolean, context: SocialRequestContext): Promise<Built | Refusal> {
    let outcome: Built | Refusal;
    // A quote priced at another Blast fee rate than the one charged now is stale: the trade asks for a new quote.
    if (createdAtMs >= quote.expiresAtMs || quote.blastFeeBps !== blastFeeBps) outcome = "quote_expired";
    else {
      try {
        outcome = await build(quote, caller, accountId, acceptFee, context.client.rateKey, context.request.signal);
      } catch (error) {
        if (!(error instanceof FeeRequired)) throw error;
        recordMetric("social.trade", { step: "create", outcome: "fee_required" });
        throw new SocialRouteError("sponsorship_unavailable", { extra: { fee_mist: error.feeMist.toString(), required_mist: walletTradeGasBudget(error.feeMist).toString() } });
      }
    }

    return outcome;
  }

  async function create(context: SocialRequestContext): Promise<Response> {
    const { quoteId, amountIn, minOutText, key, acceptFee } = await swapInput(context.request);
    const accountId = context.account!.account_id;
    const caller = context.caller!;
    const quoteDigest = createHash("sha256").update(quoteId).digest();

    const existing = await readByKey(accountId, key);
    if (existing) return replay(context, existing, quoteDigest);

    // The router before the quote: a misconfigured Blast fee answers `service_unavailable`, never a trade without it.
    const blastFeeBps = dependencies.router().fee?.bps ?? 0;
    // The quote, opened: sealed by this service, for this account, with exactly these numbers.
    const quote = await boundQuote(quoteId, accountId, amountIn, minOutText, caller);

    const tradeId = randomUUID();
    const createdAtMs = now();
    const coins = await readTradeCoins(database(), [quote.inCoin, quote.outCoin], createdAtMs);
    const inCoin = coins.get(quote.inCoin);
    const symbols = new Map<string, string>([
      [SOCIAL_TRADE_BASE_COINS.usdc, "USDC"],
      [SUI, "SUI"],
      ...[...coins.values()].map((coin) => [coin.coinType, coin.symbol] as const),
    ]);
    const hops: SocialTradeHop[] = quote.route.paths.map((path) => ({
      pool_id: path.poolId,
      venue: venueOf(path.provider),
      in_coin: path.from,
      out_coin: path.target,
      amount_in: path.amountIn.toString(),
      amount_out: path.amountOut.toString(),
    }));
    const facts = {
      label: routeLabel(quote.route.paths.map((path) => ({ ...path, venue: venueOf(path.provider) })), quote.inCoin, quote.outCoin, symbols),
      usd: inCoin && inCoin.usdPrice !== null ? atomsToUsd(quote.amountIn.toString(), inCoin.decimals, inCoin.usdPrice) : null,
    };

    const outcome = await buildCurrentQuote(quote, blastFeeBps, createdAtMs, caller, accountId, acceptFee, context);

    const { built, refusal, balanceFailure } = preparationFacts(outcome);
    const digest = built ? TransactionDataBuilder.getDigestFromBytes(built.bytes) : null;
    function insertValues() {
      return [
        tradeId, accountId, key, quoteDigest, quote.side, normalizeSuiAddress(quote.sender), quote.inCoin, quote.outCoin,
        quote.amountIn.toString(), quote.amountOut.toString(), quote.minOut.toString(), quote.slippageBps, JSON.stringify(hops),
        facts.label, quote.expiresAtMs, facts.usd, built?.payer ?? null, built?.reservationId ?? null,
        built ? Buffer.from(built.bytes) : null, digest, built?.expiresAtMs ?? null, built ? "built" : "failed",
        built ? null : refusal, createdAtMs, balanceFailure === null ? null : JSON.stringify(balanceFailure),
      ];
    }
    const values = insertValues();
    let row: TradeRow | null;
    try {
      row = await context.transaction(async (social) => {
        const inserted = (await social.write<TradeRow>("social_swap_intents", TRADE_INSERT_SQL, values)).rows[0] ?? null;
        if (!inserted) return null;
        await logTrade(
          social,
          inserted,
          built ? { state: "submitted", digest } : { state: "failed", digest: null, failureCode: refusal!, settledAtMs: createdAtMs },
        );
        return inserted;
      }, { label: "social.trade" });
    } catch (error) {
      // The same transaction built twice (a replay racing the first) is the first's.
      if (!isUniqueViolation(error)) throw error;
      row = null;
    }
    if (!row) {
      const first = await readByKey(accountId, key);
      if (!first) throw new SocialRouteError("service_unavailable");
      return replay(context, first, quoteDigest);
    }
    recordMetric("social.trade", {
      step: "create",
      outcome: built ? "built" : refusal,
      payer: built?.payer ?? null,
      side: quote.side,
      hops: quote.route.paths.length,
    });
    return context.json(tradeBody(row), 201);
  }

  function settlement(row: TradeRow, executed: ExecutedTrade | null, at: number) {
    let state: "confirmed" | "failed";
    let failure: SocialTradeFailure | null = null;
    let filled: bigint | null = null;
    if (!executed) {
      if (at <= Number(row.expires_at_ms) + TRADE_SETTLE_GRACE_MS) return null;
      state = "failed";
      failure = "expired";
    } else if (executed.success) {
      filled = filledOut(executed, row);
      // A fill below the minimum cannot land; were one ever reported, it is not a success.
      if (filled >= BigInt(row.min_out)) state = "confirmed";
      else {
        state = "failed";
        failure = "price_moved";
        filled = null;
      }
    } else {
      state = "failed";
      const slippage = executed.minimumOutFailed || (executed.abort?.module === "errors" && executed.abort.code === 1);
      failure = slippage ? "price_moved" : "execution_failed";
    }

    return { state, failure, filled };
  }

  async function settle(context: SocialRequestContext): Promise<Response> {
    const tradeId = routeSegments(SOCIAL_TRADE_SETTLE_PATH, new URL(context.request.url).pathname)?.trade_id ?? "";
    if (!z.string().regex(UUID).safeParse(tradeId).success) throw new SocialRouteError("invalid_parameter");
    const accountId = context.account!.account_id;
    const { rows } = await database().read<TradeRow>(`SELECT ${TRADE_COLUMNS} FROM social_swap_intents WHERE trade_id = $1::uuid AND account_id = $2::uuid`, [tradeId, accountId]);
    const row = rows[0];
    if (!row) throw new SocialRouteError("not_found");
    if (row.state !== "built" || row.digest === null) return context.json(tradeBody(row));

    let executed: ExecutedTrade | null;
    try {
      executed = await dependencies.transactions().executed(row.digest, context.request.signal);
    } catch {
      // The fullnode could not answer: nothing is known, so nothing is settled (never `expired` on an outage).
      recordMetric("social.trade", { step: "settle", outcome: "lookup_failed" });
      return context.json(tradeBody(row));
    }
    const at = now();
    const result = settlement(row, executed, at);
    if (result === null) return context.json(tradeBody(row));
    const { state, failure, filled } = result;

    const settled = await context.transaction(async (social) => {
      const locked = (await social.read<TradeRow>(TRADE_LOCK_SQL, [tradeId, accountId])).rows[0];
      if (!locked || locked.state !== "built") return locked ?? null;
      const updated = (
        await social.write<TradeRow>("social_swap_intents", TRADE_SETTLE_SQL, [tradeId, state, failure, filled === null ? null : filled.toString(), at])
      ).rows[0]!;
      await recordSwapReceipt(social, updated, executed);
      await logTrade(
        social,
        updated,
        state === "confirmed"
          ? { state: "confirmed", digest: updated.digest!, settledAtMs: at }
          : { state: "failed", digest: executed ? updated.digest : null, failureCode: failure!, settledAtMs: at },
      );
      return updated;
    }, { label: "social.trade_settle" });
    recordMetric("social.trade", { step: "settle", outcome: state === "confirmed" ? "confirmed" : failure, payer: row.fee_payer });
    return context.json(tradeBody(settled ?? row));
  }

  return Object.freeze({
    create: Object.freeze({
      POST: kit.route({ name: SOCIAL_TRADE_ROUTE, auth: "account", account: "required", bucket: "social_intent", cache: "private" }, create),
    }),
    settle: Object.freeze({
      POST: kit.route({ name: SOCIAL_TRADE_SETTLE_ROUTE, auth: "account", account: "required", bucket: "social_transfer", cache: "private" }, settle),
    }),
  });
}

export type SocialSwapRoutes = ReturnType<typeof createSocialSwapRoutes>;
