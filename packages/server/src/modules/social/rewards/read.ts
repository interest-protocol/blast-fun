import { socialParameter, socialSingle } from "@blast/server/modules/social/route-kit/validation.ts";
import { z } from "zod";
import { wireIconUrl, wireText } from "@blast/core/modules/social/contracts/financial-wire.ts";

import { recordMetric } from "@blast/core/lib/metrics.ts";
import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";

import {
  SOCIAL_REWARDS_PAGE_DEFAULT,
  SOCIAL_REWARDS_PAGE_MAX,
  type RewardAmounts,
  type SocialRewardCoin,
  type SocialRewardPayout,
  type SocialRewardsPage,
} from "@blast/core/modules/social/contracts/rewards.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";
import { readSteps } from "@blast/server/modules/social/read-steps.ts";

/** Holder payouts and publication counts come from canonical native views; unpaid positive allocations come from the daily relay reader. */

/** A page cursor: the last payout's chain position, as decimal strings. */
export type RewardsCursor = Readonly<{
  checkpoint: string;
  txSlot: string;
  eventSlot: string;
}>;
export type RewardsQuery = Readonly<{
  limit: number;
  cursor: RewardsCursor | null;
  presaleId: string | null;
  vaultId?: string | null;
}>;

const UINT = /^(0|[1-9][0-9]{0,18})$/;
const U32_MAX = 4_294_967_295n;

export function encodeRewardsCursor(cursor: RewardsCursor): string {
  return Buffer.from(
    JSON.stringify([cursor.checkpoint, cursor.txSlot, cursor.eventSlot]),
  ).toString("base64url");
}

/** A cursor from `encodeRewardsCursor`, or `invalid_parameter` (`cursor`). */
const uintCursorPart = z.string().regex(UINT);
const rewardsCursorSchema = z.tuple([
  uintCursorPart.pipe(z.string().refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n)),
  uintCursorPart.pipe(z.string().refine((value) => BigInt(value) <= U32_MAX)),
  uintCursorPart.pipe(z.string().refine((value) => BigInt(value) <= U32_MAX)),
]);

export function decodeRewardsCursor(raw: string): RewardsCursor {
  let parsed: unknown = null;
  if (raw.length <= 200) {
    try {
      parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    } catch {
      parsed = null;
    }
  }
  const decoded = rewardsCursorSchema.safeParse(parsed);
  if (!decoded.success) throw new SocialRouteError("invalid_parameter", { extra: { parameter: "cursor" } });
  const [checkpoint, txSlot, eventSlot] = decoded.data;
  return { checkpoint, txSlot, eventSlot };
}

/** `limit` (1 to 50, default 20), `cursor`, and either `presale` or `vault`, each at most once. */
export function parseRewardsQuery(url: URL): RewardsQuery {
  const one = (name: string) => socialSingle(url.searchParams, name);
  const rawLimit = one("limit");
  const limit = socialParameter(z.string().regex(/^[1-9][0-9]?$/).transform(Number).pipe(z.number().max(SOCIAL_REWARDS_PAGE_MAX)).nullable().transform((value) => value ?? SOCIAL_REWARDS_PAGE_DEFAULT), rawLimit, "limit");
  const presaleId = one("presale");
  socialParameter(z.string().regex(SUI_OBJECT_ID_PATTERN).nullable(), presaleId, "presale");
  const vaultId = one("vault");
  socialParameter(z.string().regex(SUI_OBJECT_ID_PATTERN).refine(() => presaleId === null).nullable(), vaultId, "vault");
  const rawCursor = one("cursor");
  return {
    limit,
    cursor: rawCursor === null ? null : decodeRewardsCursor(rawCursor),
    presaleId,
    ...(vaultId === null ? {} : { vaultId }),
  };
}

const REWARD_SOURCES_SQL = `
  SELECT v.vault_id, CASE WHEN v.origin_kind='presale' THEN v.origin_id END AS presale_id,
    CASE WHEN v.origin_kind='presale' THEN v.origin_id ELSE v.vault_id END AS source_id,
    coalesce(nullif(m.name,''),nullif(m.symbol,''),'Coin') AS name, coalesce(nullif(m.symbol,''),'COIN') AS symbol,
    coalesce(m.icon_url,'') AS icon_url, m.decimals AS sale_decimals,
    v.quote_type, coalesce(q.symbol,'QUOTE') AS quote_symbol, q.decimals AS quote_decimals
  FROM chain_read_v1.vaults v
  JOIN chain_read_v1.coin_metadata m ON m.coin_type=v.meme_type
  JOIN chain_read_v1.coin_metadata q ON q.coin_type=v.quote_type
  WHERE m.decimals IS NOT NULL AND q.decimals IS NOT NULL`;

/**
 * Wallet payouts in reverse chain order. `$2` filters by presale, `$7` by vault,
 * and `$3..$5` is the previous page's last chain position.
 */
export const REWARD_PAYOUTS_SQL = `
  SELECT s.presale_id, p.vault_id, s.source_id, p.round_id, r.number::text AS round_number,
    p.meme_amount::text AS meme_amount, p.quote_amount::text AS quote_amount, p.tx_digest AS digest,
    p.timestamp_ms::text AS timestamp_ms, coalesce(p.relayed_by,p.beneficiary) AS relayed_by,
    p.checkpoint::text AS checkpoint, p.tx_slot::text AS tx_slot, p.event_slot::text AS event_slot
  FROM chain_read_v1.vault_reward_payouts p
  JOIN (${REWARD_SOURCES_SQL}) s ON s.vault_id=p.vault_id
  JOIN chain_read_v1.vault_rounds r ON r.round_id=p.round_id AND r.vault_id=p.vault_id
  WHERE p.beneficiary = ANY($1::text[])
    AND ($2::text IS NULL OR s.presale_id = $2::text)
    AND ($7::text IS NULL OR p.vault_id = $7::text)
    AND ($3::bigint IS NULL OR (p.checkpoint, p.tx_slot, p.event_slot) < ($3::bigint, $4::bigint, $5::bigint))
  ORDER BY p.checkpoint DESC, p.tx_slot DESC, p.event_slot DESC
  LIMIT $6`;

export const REWARD_COINS_SQL = `
  SELECT s.*, rd.rounds, coalesce(pd.payouts,0) AS payouts,
    coalesce(pd.meme,0)::text AS received_meme, coalesce(pd.quote,0)::text AS received_quote,
    pd.last_ms::text AS last_payout_ms
  FROM (${REWARD_SOURCES_SQL}) s
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS payouts, sum(p.meme_amount) AS meme, sum(p.quote_amount) AS quote, max(p.timestamp_ms) AS last_ms
    FROM chain_read_v1.vault_reward_payouts p WHERE p.beneficiary = ANY($1::text[]) AND p.vault_id=s.vault_id
  ) pd ON TRUE
  LEFT JOIN LATERAL (
    SELECT nullif(count(*),0)::int AS rounds FROM chain_read_v1.vault_rounds r
    WHERE r.vault_id=s.vault_id AND EXISTS (SELECT 1 FROM chain_read_v1.watermark di WHERE di.network = $3::text)
  ) rd ON TRUE
  WHERE pd.payouts>0 OR s.source_id=ANY($2::text[])
  ORDER BY pd.last_ms DESC NULLS LAST, s.source_id`;

/**
 * Which of the waiting leaves (`$1` round ids, `$2` leaf indexes, pairwise)
 * blast-infra already shows paid: the relay drops a paid leaf only when it
 * next reads its round, so the payout can show first.
 */
export const PAID_LEAVES_SQL = `
  SELECT p.round_id, p.index::text AS leaf_index
  FROM chain_read_v1.vault_reward_payouts p
  JOIN unnest($1::text[], $2::numeric[]) AS leaf(round_id, leaf_index) ON leaf.round_id = p.round_id AND leaf.leaf_index = p.index`;

assertChainReadThroughViews(PAID_LEAVES_SQL);

type PayoutRow = Readonly<{
  presale_id: string | null;
  vault_id?: string;
  source_id?: string;
  round_id: string;
  round_number: string;
  meme_amount: string;
  quote_amount: string;
  digest: string;
  timestamp_ms: string;
  relayed_by: string;
  checkpoint: string;
  tx_slot: string;
  event_slot: string;
}>;

type CoinRow = Readonly<{
  presale_id: string | null;
  vault_id?: string;
  source_id?: string;
  name: string;
  symbol: string;
  icon_url: string;
  sale_decimals: number;
  quote_type: string;
  quote_symbol: string;
  quote_decimals: number;
  rounds: number | null;
  payouts: number;
  received_meme: string;
  received_quote: string;
  last_payout_ms: string | null;
}>;

/** One unpaid positive canonical daily allocation: next is queued; unpayable needs its holder's claim. */
export type WaitingAllocation = Readonly<{
  roundId: string;
  leafIndex: number;
  memeAmount: string;
  quoteAmount: string;
  reason: "next" | "unpayable";
  claimDeadlineMs: number;
}>;
export type WaitingByPresale = Readonly<{
  presaleId: string;
  vaultId?: string;
  allocations: readonly WaitingAllocation[];
}>;
/** `waitingRewardsFor(db, network, wallets)` bound to the database and network; at most `WAITING_WALLETS_MAX` (50) wallets a call. */
export type RewardsWaitingReader = (
  wallets: readonly string[],
) => Promise<readonly WaitingByPresale[]>;
const WAITING_WALLETS_MAX = 50;

type Waiting = NonNullable<SocialRewardCoin["waiting"]>;

/**
 * Each sale's waiting share by reason, from the relay's reader: leaves past
 * their claim deadline (anyone may close the round, returning them to the
 * vault) and leaves the payouts view already shows paid are left out. Null
 * when the reader is not wired or failed: the page then shows no waiting line.
 */
async function readWaiting(
  database: ReadableDatabase,
  reader: RewardsWaitingReader | null,
  wallets: readonly string[],
  nowMs: number,
): Promise<Map<string, Waiting> | null> {
  if (!reader) return null;
  const groups: WaitingByPresale[] = [];
  let at = 0;
  let failed = false;
  // Two batches at most; a refusal stops queued batches and both workers settle.
  const readBatches = async () => {
    try {
      while (!failed && at < wallets.length) {
        const batch = wallets.slice(at, at + WAITING_WALLETS_MAX);
        at += WAITING_WALLETS_MAX;
        groups.push(...(await reader(batch)));
      }
    } catch (error) {
      failed = true;
      throw error;
    }
  };
  const outcomes = await Promise.allSettled([readBatches(), readBatches()]);
  if (outcomes.some((outcome) => outcome.status === "rejected")) {
    recordMetric("social.rewards", { part: "waiting", outcome: "unavailable" });
    return null;
  }
  const leaves = groups.flatMap((group) =>
    group.allocations
      .filter((leaf) => leaf.claimDeadlineMs > nowMs)
      .map((leaf) => ({
        presaleId:
          group.presaleId === `0x${"0".repeat(64)}`
            ? group.vaultId!
            : group.presaleId,
        leaf,
      })),
  );
  if (leaves.length === 0) return new Map();
  const { rows } = await database.read<{
    round_id: string;
    leaf_index: string;
  }>(PAID_LEAVES_SQL, [
    leaves.map(({ leaf }) => leaf.roundId),
    leaves.map(({ leaf }) => String(leaf.leafIndex)),
  ]);
  const paid = new Set(rows.map((row) => `${row.round_id}:${row.leaf_index}`));
  const sums = new Map<
    string,
    Record<WaitingAllocation["reason"], { meme: bigint; quote: bigint } | null>
  >();
  for (const { presaleId, leaf } of leaves) {
    if (paid.has(`${leaf.roundId}:${leaf.leafIndex}`)) continue;
    const entry = sums.get(presaleId) ?? { next: null, unpayable: null };
    const sum = entry[leaf.reason] ?? { meme: 0n, quote: 0n };
    entry[leaf.reason] = {
      meme: sum.meme + BigInt(leaf.memeAmount),
      quote: sum.quote + BigInt(leaf.quoteAmount),
    };
    sums.set(presaleId, entry);
  }
  const out = new Map<string, Waiting>();
  const amounts = (
    sum: { meme: bigint; quote: bigint } | null,
  ): RewardAmounts | null =>
    sum ? { meme: sum.meme.toString(), quote: sum.quote.toString() } : null;
  for (const [presaleId, entry] of sums)
    out.set(presaleId, {
      next: amounts(entry.next),
      unpayable: amounts(entry.unpayable),
    });
  return out;
}

export function rewardCoinOf(
  row: CoinRow,
  waiting: Waiting | null = null,
): SocialRewardCoin {
  return {
    presale_id: row.presale_id,
    ...(row.presale_id === null && row.vault_id
      ? { vault_id: row.vault_id }
      : {}),
    ...(row.presale_id === null && row.source_id
      ? { source_id: row.source_id }
      : {}),
    // Coin metadata is whatever its publisher wrote: cut to the wire's bounds, an oversized logo dropped.
    name: wireText(row.name, 200) ?? "",
    symbol: wireText(row.symbol, 64) ?? "",
    icon_url: wireIconUrl(row.icon_url) ?? "",
    sale_decimals: row.sale_decimals,
    quote_type: row.quote_type,
    quote_symbol: wireText(row.quote_symbol, 64) ?? "",
    quote_decimals: row.quote_decimals,
    rounds: row.rounds,
    payouts: row.payouts,
    received: { meme: row.received_meme, quote: row.received_quote },
    last_payout_ms:
      row.last_payout_ms === null ? null : Number(row.last_payout_ms),
    waiting,
  };
}

export function rewardPayoutOf(
  row: PayoutRow,
  wallets: ReadonlySet<string>,
): SocialRewardPayout {
  return {
    presale_id: row.presale_id,
    ...(row.presale_id === null && row.vault_id
      ? { vault_id: row.vault_id }
      : {}),
    ...(row.presale_id === null && row.source_id
      ? { source_id: row.source_id }
      : {}),
    round_id: row.round_id,
    round_number: row.round_number,
    meme_amount: row.meme_amount,
    quote_amount: row.quote_amount,
    digest: row.digest,
    timestamp_ms: Number(row.timestamp_ms),
    relayed_by: row.relayed_by,
    self_claimed: wallets.has(row.relayed_by),
  };
}

/** One page of the wallets' payouts, and on a first page without a sale, the per-sale summary with what waits. */
export async function readRewardsPage(
  database: ReadableDatabase,
  wallets: readonly string[],
  query: RewardsQuery,
  context: Readonly<{
    nowMs: number;
    network: string | null;
    waiting: RewardsWaitingReader | null;
  }>,
): Promise<SocialRewardsPage> {
  if (wallets.length === 0)
    return {
      coins:
        query.cursor === null && query.presaleId === null && !query.vaultId
          ? []
          : null,
      payouts: [],
      next_cursor: null,
    };
  assertChainReadThroughViews(REWARD_PAYOUTS_SQL);
  assertChainReadThroughViews(REWARD_COINS_SQL);
  const { limit, cursor, presaleId } = query;
  const withCoins = cursor === null && presaleId === null && !query.vaultId;
  const step = readSteps("rewards");
  const summary = async () => {
    // The relay's waiting shares, then the paid leaves among them (`readWaiting`).
    const waiting = await step("waiting", () => readWaiting(
      database,
      context.network === null ? null : context.waiting,
      wallets,
      context.nowMs,
    ));
    const { rows } = await step("coins", () => database.read<CoinRow>(REWARD_COINS_SQL, [
      [...wallets],
      [...(waiting?.keys() ?? [])],
      context.network,
    ]));
    return rows.map((row) =>
      rewardCoinOf(
        row,
        waiting?.get(row.source_id ?? row.presale_id ?? row.vault_id!) ?? null,
      ),
    );
  };
  const [payouts, coins] = await Promise.all([
    step("payouts", () => database.read<PayoutRow>(REWARD_PAYOUTS_SQL, [
      [...wallets],
      presaleId,
      cursor?.checkpoint ?? null,
      cursor?.txSlot ?? null,
      cursor?.eventSlot ?? null,
      limit + 1,
      query.vaultId ?? null,
    ])),
    withCoins ? step("summary", summary) : null,
  ]);
  const own = new Set(wallets);
  const page = payouts.rows.slice(0, limit);
  const last = page.at(-1);
  return {
    coins,
    payouts: page.map((row) => rewardPayoutOf(row, own)),
    next_cursor:
      payouts.rows.length > limit && last
        ? encodeRewardsCursor({
            checkpoint: last.checkpoint,
            txSlot: last.tx_slot,
            eventSlot: last.event_slot,
          })
        : null,
  };
}
