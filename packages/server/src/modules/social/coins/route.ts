import { routeSegments } from "@blast/core/modules/backend-api/route-path.ts";
import { SOCIAL_TRANSFER_PATH } from "@blast/core/modules/backend-api/private/social-coins-contracts.ts";
import { z } from "zod";
import { socialInput, socialParameter } from "@blast/server/modules/social/route-kit/validation.ts";

import { readDigestJson, verifyDigestProvenance } from "@blast/server/modules/social/transactions/digest-provenance.ts";

import { recordMetric, timed } from "@blast/core/lib/metrics.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import {
  socialTransferInputSchema,
  socialWalletBalanceSchema,
  SOCIAL_TRANSFER_ROUTE,
  SOCIAL_WALLET_ROUTE,
  type SocialTransferFee,
  type SocialWallet,
  type SocialWalletBalance,
} from "@blast/core/modules/social/contracts/coins.ts";
import { PORTFOLIO_COIN_TYPES } from "@blast/core/modules/social/portfolio/read.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { SOCIAL_ROUTE_METRIC_SAMPLE_RATE, type SocialCaller, type SocialRequestContext, type SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import {
  attachDigest,
  insertTransfer,
  lockTransfer,
  logTransfer,
  readTransfer,
  sameTransfer,
  settleTransfer,
  transferBody,
  transferVerdict,
  type ExecutedTransfer,
  type TransferIntent,
  type TransferRow,
} from "@blast/server/modules/social/coins/transfers.ts";
import { walletCoinList, walletListParams } from "@blast/server/modules/social/coins/coin-list.ts";
import { COINS_FULLNODE_TIMEOUT_MS, readCoinBalance, readOwnerBalances, walletCoins, type CoinsFullnode } from "@blast/server/modules/social/coins/wallet.ts";

/** The fullnode reads behind a settlement: an executed transaction by digest, or null while it is not visible. */
export interface TransferLookup {
  executed(digest: string, signal?: AbortSignal): Promise<ExecutedTransfer | null>;
}

export type SocialCoinsRoutesDependencies = Readonly<{
  kit: SocialRouteKit;
  /** The primary (an owner sees what they just did). Resolved per request. */
  database: () => ReadableDatabase;
  /** Mainnet fullnode balance reads. Resolved per request. */
  fullnode: () => CoinsFullnode;
  /** Mainnet fullnode transaction reads. Resolved per request. */
  transactions: () => TransferLookup;
  /**
   * The caller's Blast wallet: a Privy session's embedded Sui wallet (null
   * while it does not exist), a wallet session's own address.
   */
  blastWallet: (caller: SocialCaller) => Promise<string | null>;
  verifyProvenance?: typeof verifyDigestProvenance;
  now?: () => number;
  fullnodeTimeoutMs?: number;
}>;

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WALLET_METRICS = { sampleRate: SOCIAL_ROUTE_METRIC_SAMPLE_RATE };

/** Blast's gas pool pays every caller's network fee: a Privy embedded wallet and a wallet session alike (owner ruling 2026-11-20, reversing OA-17). */
const TRANSFER_FEE: SocialTransferFee = "sponsored";

/** A value-free label of a coin type for metrics. */
function coinLabel(coinType: string): "usdc" | "sui" | "other" {
  return coinType === PORTFOLIO_COIN_TYPES.usdc ? "usdc" : coinType === PORTFOLIO_COIN_TYPES.sui ? "sui" : "other";
}

function requestIdOf(request: Request): string {
  const segment = routeSegments(SOCIAL_TRANSFER_PATH, new URL(request.url).pathname)?.id ?? "";
  if (!z.string().regex(REQUEST_ID).safeParse(segment).success) throw new SocialRouteError("invalid_parameter");
  return segment;
}

function walletReadOptions(url: string) {
  const query = new URL(url).searchParams;
  const exact = query.has("balance_coin");
  if (!exact && !query.has("identity")) return { mode: "listing", params: walletListParams(url) } as const;
  const parameter = exact ? "balance_coin" : "identity";
  if (query.size !== 1) throw new SocialRouteError("invalid_parameter", { extra: { parameter } });
  if (exact) {
    const coinType = socialParameter(socialWalletBalanceSchema.shape.coin_type, query.get(parameter), parameter);
    return { mode: "exact", coinType } as const;
  }
  socialParameter(z.literal("1"), query.get(parameter), parameter);
  return { mode: "identity" } as const;
}

/** The body's withdrawal, canonical: a coin type in `normalizeStructTag` form, positive u64 atoms, a lowercase address, an optional digest. */
function parseTransfer(body: Record<"coin_type" | "amount" | "recipient", unknown> & Partial<Record<"digest" | "transaction_bytes", unknown>>) {
  const parsed = socialInput(socialTransferInputSchema, body);
  return { coinType: parsed.coin_type, amount: parsed.amount, recipient: parsed.recipient, digest: parsed.digest ?? null, transactionBytes: body.transaction_bytes };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
}

/**
 * The coins sheet's routes (contract in `contracts/coins.ts`):
 *
 * - `GET /api/social/me/wallet`: signed in with an account, bucket
 *   `social_read`, `private, no-store`. The Blast wallet's address, who
 *   signs and who pays its fees, and its coins read from the fullnode for
 *   that one address (`coins: null` when the fullnode fails; the address
 *   still answers). `identity=1` returns wallet details only. `balance_coin`
 *   reads one canonical coin type directly from the fullnode.
 * - `PUT /api/social/me/transfers/{request_id}`: signed in with an account,
 *   bucket `social_transfer`, `private, no-store`. Records a withdrawal under
 *   the client's request id, adds its digest, and settles it against the
 *   fullnode. Idempotent per request id; nothing is ever sent from here.
 *   Each step also logs the withdrawal in `social_transactions` (R3-27), in
 *   the same transaction as its transfer record.
 */
export function createSocialCoinsRoutes(dependencies: SocialCoinsRoutesDependencies) {
  const { kit, database, fullnode, transactions, blastWallet } = dependencies;
  const now = dependencies.now ?? Date.now;

  /** Settles a submitted withdrawal from its executed transaction; the row unchanged while it is not visible. */
  async function settle(context: SocialRequestContext, row: TransferRow): Promise<TransferRow> {
    if (row.status !== "submitted" || row.digest === null) return row;
    let executed: ExecutedTransfer | null;
    try {
      executed = await transactions().executed(row.digest, context.request.signal);
    } catch {
      executed = null;
    }
    if (!executed) {
      recordMetric("social.transfer", { step: "settle", outcome: "not_visible", coin: coinLabel(row.coin_type), fee: row.fee });
      return row;
    }
    const verdict = transferVerdict(row, executed);
    const settled = await context.transaction(async (social) => {
      const done = await settleTransfer(social, row.request_id, verdict);
      // The log moves with the withdrawal, in the same transaction (R3-27).
      if (done) await logTransfer(social, done);
      return done;
    });
    recordMetric("social.transfer", {
      step: "settle",
      outcome: verdict.status === "confirmed" ? "confirmed" : verdict.failure,
      coin: coinLabel(row.coin_type),
      fee: row.fee,
    });
    return settled ?? (await readTransfer(database(), row.request_id)) ?? row;
  }

  return Object.freeze({
    wallet: kit.route(
      { name: SOCIAL_WALLET_ROUTE, auth: "account", account: "required", bucket: "social_read", cache: "private" },
      async (context) => {
        const read = walletReadOptions(context.request.url);
        const { mode } = read;
        const caller = context.caller!;
        const address = await timed("social.wallet", () => blastWallet(caller), { mode, step: "resolve_wallet" }, WALLET_METRICS);
        if (mode === "exact") {
          if (address === null) throw new SocialRouteError("blast_wallet_missing");
          const signal = AbortSignal.any([
            context.request.signal,
            AbortSignal.timeout(dependencies.fullnodeTimeoutMs ?? COINS_FULLNODE_TIMEOUT_MS),
          ]);
          const atoms = await timed("social.wallet", () => readCoinBalance(fullnode(), address, read.coinType, signal), { mode, step: "fullnode" }, WALLET_METRICS);
          const body: SocialWalletBalance = { address, coin_type: read.coinType, atoms, as_of_ms: now() };
          return context.json(body);
        }
        const params = mode === "listing" ? read.params : null;
        const fee = TRANSFER_FEE;
        let coins: SocialWallet["coins"] = null;
        if (mode === "listing" && address !== null) {
          try {
            const balances = await timed("social.wallet", () => readOwnerBalances(fullnode(), address, dependencies.fullnodeTimeoutMs), { mode, step: "fullnode" }, WALLET_METRICS);
            coins = await timed("social.wallet", () => walletCoins(database(), balances, now(), params?.hideTestMarkets), { mode, step: "enrich_coins" }, WALLET_METRICS);
          } catch (error) {
            if (error instanceof SocialRouteError) throw error;
            recordMetric("social.wallet", { outcome: "coins_unavailable" });
            coins = null;
          }
        }
        const body: SocialWallet = { address, signer: caller.kind, fee, coins, as_of_ms: now() };
        return context.json(params ? walletCoinList(body, params) : body);
      },
    ),
    transfer: kit.route(
      { name: SOCIAL_TRANSFER_ROUTE, auth: "account", account: "required", bucket: "social_transfer", cache: "private" },
      async (context) => {
        const requestId = requestIdOf(context.request);
        const input = parseTransfer(await readDigestJson(context.request, ["coin_type", "amount", "recipient"], ["digest", "transaction_bytes"]));
        const caller = context.caller!;
        const account = context.account!;
        const sender = await blastWallet(caller);
        if (sender === null) throw new SocialRouteError("blast_wallet_missing");
        if (input.recipient === sender) throw new SocialRouteError("invalid_recipient");
        const intent: TransferIntent = { sender, recipient: input.recipient, coinType: input.coinType, amount: input.amount, fee: TRANSFER_FEE };
        const labels = { coin: coinLabel(intent.coinType), fee: intent.fee };

        if (input.digest !== null) {
          const stored = await readTransfer(database(), requestId);
          if (stored?.account_id !== account.account_id || stored.digest !== input.digest) {
            await (dependencies.verifyProvenance ?? verifyDigestProvenance)(
              { digest: input.digest, sender, transactionBytes: input.transactionBytes },
              async () => (await transactions().executed(input.digest!, context.request.signal))?.sender ?? null,
            );
          }
        }

        let created = false;
        let row: TransferRow;
        try {
          row = await context.transaction(async (social) => {
            const record = async (): Promise<TransferRow> => {
              const inserted = await insertTransfer(social, { requestId, accountId: account.account_id, intent, digest: input.digest });
              if (inserted) {
                created = true;
                return inserted;
              }
              const stored = await lockTransfer(social, requestId);
              // Another account's request id is not this caller's to read.
              if (!stored || stored.account_id !== account.account_id) throw new SocialRouteError("not_found");
              if (!sameTransfer(stored, intent)) throw new SocialRouteError("transfer_conflict", { extra: { transfer: transferBody(stored) } });
              if (input.digest === null || stored.digest === input.digest) return stored;
              if (stored.digest !== null) throw new SocialRouteError("transfer_conflict", { extra: { transfer: transferBody(stored) } });
              return attachDigest(social, requestId, input.digest);
            };
            const recorded = await record();
            // The withdrawal's transaction-log row, written with it (R3-27).
            await logTransfer(social, recorded);
            return recorded;
          });
        } catch (error) {
          // The digest already belongs to another withdrawal (or another logged transaction).
          if (isUniqueViolation(error)) {
            recordMetric("social.transfer", { step: "record", outcome: "digest_taken", ...labels });
            throw new SocialRouteError("transfer_conflict");
          }
          if (error instanceof SocialRouteError && error.code !== "not_found") {
            recordMetric("social.transfer", { step: "record", outcome: error.code, ...labels });
          }
          throw error;
        }
        recordMetric("social.transfer", { step: "record", outcome: created ? "recorded" : "repeat", status: row.status, ...labels });

        const settled = await settle(context, row);
        const status = created ? 201 : settled.status === "submitted" ? 202 : 200;
        return context.json(transferBody(settled), status);
      },
    ),
  });
}

export type SocialCoinsRoutes = ReturnType<typeof createSocialCoinsRoutes>;
