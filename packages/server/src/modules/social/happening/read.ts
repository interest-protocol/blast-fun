import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { SocialConfig } from "@blast/core/modules/social/contracts/config.ts";
import {
  HAPPENING_LAST_HOUR_MS,
  HAPPENING_LIST_MAX,
  HAPPENING_TAPE_KINDS,
  HAPPENING_TAPE_MAX,
  HAPPENING_TODAY_MAX,
  type HappeningPresale,
  type HappeningTapeEvent,
  type HappeningTapeKind,
  type SocialHappeningResponse,
} from "@blast/core/modules/social/contracts/happening.ts";
import type { FeedItemActor, FeedItemPresale } from "@blast/core/modules/social/contracts/items.ts";
import { profilePagePath } from "@blast/core/modules/social/contracts/profiles.ts";
import { settledAll } from "@blast/server/lib/settled-all.ts";
import { createPublicPresaleReader } from "@blast/server/modules/social/presales/public-reads.ts";
import { readAsOf } from "@blast/server/modules/social/items/as-of.ts";
import { toUsd } from "@blast/core/modules/social/items/decimal.ts";
import { readPresaleChips, shortAddress } from "@blast/server/modules/social/items/mapper.ts";
import { statusFilterSql } from "@blast/server/modules/social/presales/summary.ts";
import { publicCover, storedCoverOf } from "@blast/server/modules/social/sales/store.ts";
import { walletNamingSql } from "@blast/core/modules/social/read-model/naming.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { PUBLIC_PRESALES, PUBLIC_ACTIVITY, pinnablePresaleSql } from "@blast/core/modules/social/read-model/chain-presales.ts";
import { readTopCoins } from "@blast/server/modules/social/happening/top-coins.ts";
import { saleMetadataJoinSql } from "@blast/server/modules/social/sales/store.ts";

/**
 * Home's live public reads (contract in `contracts/happening.ts`), every one
 * on the same database (the replica in production) and only through
 * `chain_read_v1` views. The existing reads bound activity by their windows;
 * Top coins adds the market aggregate over shown, freshly priced coins.
 *
 * 1. the watermark (each pipeline's committed checkpoint and time) and `as_of`;
 * 2. the last hour's commits of shown sales: a range of blast-infra's
 *    `(timestamp_ms DESC)` activity index;
 * 3. the tape: the newest rows of that index whose sale is shown, then the
 *    naming rule once per row (at most `HAPPENING_TAPE_MAX` owner lookups by
 *    address);
 * 4. the open, pending and recently backed presales, plus the admin's Home
 *    pins, joined to shown sales;
 * 5. their chips (the post mapper's presale read, prices included);
 * 6. their commits in the velocity window, by blast-infra's
 *    `(presale_id, timestamp_ms DESC)` index;
 * 7. their follower counts, by `social_follows_target_idx`.
 *
 * Activity counts only up to its pipeline's committed checkpoint (presale
 * kinds: the presale pipeline; trades: the market pipeline), and every window
 * ends at the chain clock: the earlier of the presale pipeline's committed
 * time and `nowMs`.
 *
 * The tape and the last-hour totals use `PUBLIC_ACTIVITY` inside the index
 * scan, so only public markets occupy tape slots or contribute to the totals.
 * The presale lists start from `PUBLIC_PRESALES`; the velocity window and
 * follower counts read only the sales those lists hold.
 */

type BoundsRow = {
  market_checkpoint: string | null;
  market_timestamp_ms: string | null;
  presale_checkpoint: string | null;
  presale_timestamp_ms: string | null;
};

const BOUNDS_SQL = `SELECT market_checkpoint, market_timestamp_ms, presale_checkpoint, presale_timestamp_ms
FROM chain_read_v1.watermark`;

/**
 * $1 clock, $2 presale checkpoint. Commits of shown sales only. Unnamed
 * wallets count; a null `usd_value` counts the wallet, not the USD.
 */
const LAST_HOUR_SQL = `SELECT count(DISTINCT a.actor)::int AS wallets, coalesce(sum(a.usd_value), 0)::text AS usd,
  count(*) FILTER (WHERE a.usd_value IS NULL)::int AS unpriced
FROM ${PUBLIC_ACTIVITY} a
WHERE a.timestamp_ms >= $1::bigint - ${HAPPENING_LAST_HOUR_MS} AND a.timestamp_ms <= $1::bigint
  AND a.kind = 'presale_commit' AND a.checkpoint <= $2::bigint`;

/**
 * $1 clock, $2 kinds, $3 presale checkpoint, $4 market checkpoint, $5 limit.
 * The newest rows of shown sales first (a LIMIT subquery, so the naming and
 * lookups run once per kept row; the shown-sale filter is inside it, before
 * the LIMIT, so hidden rows never take a place), then each wallet's owner if
 * the naming rule names it at the row's time (`walletNamingSql`; `OFFSET 0`
 * keeps it a per-row lookup by address, as the notification generator does:
 * flattened, the planner built the whole owners view, 67 ms at 10k accounts),
 * then the sale's symbol: by `presale_id`, or for a row without one by its
 * coin (the filter guarantees one of the two).
 */
const TAPE_SQL = `SELECT l.activity_id, l.kind, l.timestamp_ms::text AS timestamp_ms, l.actor, coalesce(l.presale_id, ps.presale_id) AS presale_id, l.usd_value::text AS usd_value,
  l.coin_amount::text AS coin_amount, l.quote_refund::text AS quote_refund,
  coalesce(p.sale_symbol, ps.sale_symbol, '') AS symbol, p.sale_decimals, p.quote_decimals, p.quote_symbol,
  i.callsign, i.display_name, i.avatar_url, i.x_handle, i.verified
FROM (
  SELECT a.activity_id, a.checkpoint, a.tx_slot, a.event_slot, a.part, a.kind, a.timestamp_ms, a.actor, a.presale_id,
    a.coin_type, a.usd_value, a.coin_amount, a.quote_refund
  FROM ${PUBLIC_ACTIVITY} a
  WHERE a.timestamp_ms <= $1::bigint AND a.kind = ANY($2::text[])
    AND a.checkpoint <= CASE WHEN a.kind IN ('presale_commit', 'presale_claim') THEN $3::bigint ELSE $4::bigint END
  ORDER BY a.timestamp_ms DESC, a.checkpoint DESC, a.tx_slot DESC, a.event_slot DESC, a.part DESC
  LIMIT $5::int
) AS l
LEFT JOIN LATERAL (SELECT owner.account_id, owner.named_from_ms FROM ${walletNamingSql("l.actor")} AS owner OFFSET 0) AS n
  ON n.named_from_ms <= l.timestamp_ms
LEFT JOIN social_account_identities i ON i.account_id = n.account_id
LEFT JOIN ${PUBLIC_PRESALES} p ON p.presale_id = l.presale_id
LEFT JOIN ${PUBLIC_PRESALES} ps ON l.presale_id IS NULL AND ps.sale_token = l.coin_type
ORDER BY l.timestamp_ms DESC, l.checkpoint DESC, l.tx_slot DESC, l.event_slot DESC, l.part DESC`;

/**
 * The presales Home can show, with the role each plays: open ones still taking
 * commits by closing time, pending ones by opening time, and the most recently
 * backed live presales in the last hour. $1 chain clock, $2 open/pending limit,
 * $3 presale checkpoint, $4 server clock, $5 include recent presales.
 * "Open" and "pending" are the list's Live and Upcoming
 * tabs (`statusFilterSql`), so Home and the list agree on what is live; it
 * stays one statement (one round trip; reading the list's tab keys as two
 * more statements measured no faster and needs two more replica connections
 * per read).
 */
const CANDIDATES_SQL = `SELECT * FROM ((SELECT p.presale_id, 'open' AS role, NULL::bigint AS launched_ms, p.end_ms AS sort_ms
  FROM ${PUBLIC_PRESALES} p WHERE ${statusFilterSql("live", () => "$1::bigint")} ORDER BY p.end_ms, p.presale_id LIMIT $2::int)
UNION ALL
(SELECT p.presale_id, 'pending', NULL::bigint, p.start_ms
  FROM ${PUBLIC_PRESALES} p WHERE ${statusFilterSql("upcoming", () => "$1::bigint")} ORDER BY p.start_ms, p.presale_id LIMIT $2::int)
UNION ALL
(SELECT p.presale_id, 'recent', NULL::bigint, max(a.timestamp_ms) AS last_commit_ms
  FROM chain_read_v1.activity a JOIN ${PUBLIC_PRESALES} p ON p.presale_id = a.presale_id
  WHERE $5::boolean AND a.kind = 'presale_commit' AND a.timestamp_ms >= $4::bigint - ${HAPPENING_LAST_HOUR_MS}
    AND a.timestamp_ms <= $1::bigint AND a.checkpoint <= $3::bigint
    AND ${statusFilterSql("live", () => "$4::bigint")}
  GROUP BY p.presale_id
  ORDER BY last_commit_ms DESC, p.presale_id
  LIMIT ${HAPPENING_LIST_MAX})) AS candidates`;

/** The same saved pins that lead Home's posts; no automatic recap fallback. */
const PINNED_SQL = `SELECT p.presale_id, l.launched_ms::text, m.cover_key, m.cover_url, m.cover_width, m.cover_height,
  m.cover_source_width, m.cover_source_height
FROM social_presale_pins pin
JOIN ${PUBLIC_PRESALES} p ON p.presale_id = pin.presale_id
LEFT JOIN LATERAL (
  SELECT max(timestamp_ms) AS launched_ms FROM chain_read_v1.presale_lifecycle
  WHERE presale_id = p.presale_id AND state = 'migrated'
) l ON true
${saleMetadataJoinSql("p.presale_id")}
WHERE ${pinnablePresaleSql("p", "$2::bigint")}
ORDER BY pin.pinned_at DESC, pin.presale_id COLLATE "C" DESC
LIMIT $1::int`;

/** $1 presale ids, $2 clock, $3 window, $4 presale checkpoint. */
const WINDOW_SQL = `SELECT a.presale_id, sum(a.quote_amount)::text AS raised
FROM ${PUBLIC_ACTIVITY} a
WHERE a.presale_id = ANY($1::text[]) AND a.kind = 'presale_commit'
  AND a.timestamp_ms > $2::bigint - $3::bigint AND a.timestamp_ms <= $2::bigint AND a.checkpoint <= $4::bigint
GROUP BY a.presale_id`;

const INTERESTED_SQL = `SELECT f.target_id AS presale_id, count(*)::int AS interested
FROM social_follows f
WHERE f.target_kind = 'presale' AND f.target_id = ANY($1::text[])
GROUP BY f.target_id`;

for (const text of [BOUNDS_SQL, LAST_HOUR_SQL, TAPE_SQL, CANDIDATES_SQL, PINNED_SQL, WINDOW_SQL]) assertChainReadThroughViews(text);

type TapeRow = {
  activity_id: string;
  kind: HappeningTapeKind;
  timestamp_ms: string;
  actor: string;
  presale_id: string | null;
  usd_value: string | null;
  coin_amount: string | null;
  quote_refund: string | null;
  symbol: string;
  sale_decimals: number | null;
  quote_decimals: number | null;
  quote_symbol: string | null;
  callsign: string | null;
  display_name: string | null;
  avatar_url: string | null;
  x_handle: string | null;
  verified: boolean | null;
};

type PinnedRow = {
  presale_id: string;
  launched_ms: string | null;
  cover_key?: string | null;
  cover_url?: string | null;
  cover_width?: number | null;
  cover_height?: number | null;
  cover_source_width?: number | null;
  cover_source_height?: number | null;
};
type CandidateRow = PinnedRow & { role: "open" | "pending" | "recent"; sort_ms: string };

export type HappeningRequest = Readonly<{
  config: SocialConfig;
  nowMs: number;
  /** Activity kinds left out (the trade kinds while trading is hidden, OA-7). */
  hiddenKinds: readonly string[];
  includeRecentPresales?: boolean;
}>;

/** `atoms ÷ 10^decimals` as a plain decimal string (exact; trailing zeros trimmed). */
export function wholeUnits(atoms: string, decimals: number): string {
  if (!/^(0|[1-9][0-9]*)$/.test(atoms) || !Number.isInteger(decimals) || decimals < 0) throw new TypeError("Not atoms.");
  if (decimals === 0) return atoms;
  const padded = atoms.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function actorOf(row: TapeRow): FeedItemActor {
  if (row.callsign) {
    return {
      type: "account",
      callsign: row.callsign,
      display_name: row.display_name,
      avatar_url: row.avatar_url,
      x_handle: row.x_handle,
      verified: row.verified === true,
      path: profilePagePath(row.callsign),
    };
  }
  return { type: "address", address: row.actor, short: shortAddress(row.actor) };
}

function tapeEvent(row: TapeRow): HappeningTapeEvent {
  const claim = row.kind === "presale_claim";
  const tokens = claim && row.coin_amount !== null && row.coin_amount !== "0" && row.sale_decimals !== null
    ? wholeUnits(row.coin_amount, row.sale_decimals)
    : null;
  const refund = claim && row.quote_refund !== null && row.quote_refund !== "0" && row.quote_decimals !== null
    ? wholeUnits(row.quote_refund, row.quote_decimals)
    : null;
  return {
    activity_id: row.activity_id,
    kind: row.kind,
    occurred_at_ms: Number(row.timestamp_ms),
    actor: actorOf(row),
    presale_id: row.presale_id,
    symbol: row.symbol,
    usd: claim || row.usd_value === null ? null : toUsd(row.usd_value),
    tokens,
    refund,
    // R3-40: the sale's quote, so a SUI sale's refund reads in SUI.
    quote_symbol: row.presale_id !== null ? row.quote_symbol : null,
  };
}

/** The watermark's per-pipeline bounds, or `service_unavailable` when a pipeline has committed nothing readable. */
async function readBounds(db: ReadableDatabase): Promise<{ presaleCheckpoint: number; presaleMs: number; marketCheckpoint: number; marketMs: number }> {
  const row = (await db.read<BoundsRow>(BOUNDS_SQL)).rows[0];
  if (!row || row.presale_checkpoint === null || row.presale_timestamp_ms === null || row.market_checkpoint === null) {
    throw new SocialRouteError("service_unavailable");
  }
  return {
    presaleCheckpoint: Number(row.presale_checkpoint),
    presaleMs: Number(row.presale_timestamp_ms),
    marketCheckpoint: Number(row.market_checkpoint),
    marketMs: Number(row.market_timestamp_ms ?? row.presale_timestamp_ms),
  };
}

/** `raised ÷ target` of a velocity window, for ordering only. */
function velocityOf(windowRaised: string, presale: FeedItemPresale): number {
  const target = Number(presale.raise_target);
  return target > 0 ? Number(windowRaised) / target : 0;
}

/** The whole `GET /api/social/happening` body. */
export async function readHappening(db: ReadableDatabase, request: HappeningRequest): Promise<SocialHappeningResponse> {
  const { config, nowMs, includeRecentPresales = false } = request;
  const [bounds, asOf] = await settledAll([readBounds(db), readAsOf(db)]);
  if (!asOf) throw new SocialRouteError("service_unavailable");
  const clockMs = Math.min(nowMs, bounds.presaleMs);
  const hidden = new Set(request.hiddenKinds);
  const kinds = [...HAPPENING_TAPE_KINDS, "trade_buy", "trade_sell"].filter((kind) => !hidden.has(kind));

  // Dependent sale reads start as soon as candidates/pins settle, alongside Top coins.
  const presales = async () => {
    const [candidates, pins] = await settledAll([
      Promise.resolve().then(() => db.read<CandidateRow>(CANDIDATES_SQL, [clockMs, HAPPENING_TODAY_MAX, bounds.presaleCheckpoint, nowMs, includeRecentPresales])),
      Promise.resolve().then(() => db.read<PinnedRow>(PINNED_SQL, [HAPPENING_TODAY_MAX, nowMs])),
    ]);
    const ids = [...new Set([...candidates.rows, ...pins.rows].map((row) => row.presale_id))];
    const openIds = candidates.rows.filter((row) => row.role === "open").map((row) => row.presale_id);
    const [chips, windows, interested] = await settledAll([
      readPresaleChips(db, ids, nowMs),
      openIds.length
        ? Promise.resolve().then(() => db.read<{ presale_id: string; raised: string }>(WINDOW_SQL, [openIds, clockMs, config.fastest_window_ms, bounds.presaleCheckpoint]))
        : null,
      ids.length ? Promise.resolve().then(() => db.read<{ presale_id: string; interested: number }>(INTERESTED_SQL, [ids])) : null,
    ]);
    const windowOf = new Map((windows?.rows ?? []).map((row) => [row.presale_id, row.raised]));
    const interestedOf = new Map((interested?.rows ?? []).map((row) => [row.presale_id, row.interested]));

    const saleOf = (row: PinnedRow): HappeningPresale[] => {
      const presale = chips.get(row.presale_id);
      if (!presale) return [];
      return [{
        presale,
        cover: publicCover(storedCoverOf({
          cover_key: row.cover_key ?? null,
          cover_url: row.cover_url ?? null,
          cover_width: row.cover_width ?? null,
          cover_height: row.cover_height ?? null,
          cover_source_width: row.cover_source_width ?? null,
          cover_source_height: row.cover_source_height ?? null,
        })),
        interested: interestedOf.get(row.presale_id) ?? 0,
        window_raised: windowOf.get(row.presale_id) ?? "0",
        launched_ms: row.launched_ms === null ? null : Number(row.launched_ms),
      }];
    };
    const byRole = (role: "open" | "pending") => candidates.rows.filter((row) => row.role === role).flatMap(saleOf);
    const open = byRole("open");
    const pending = byRole("pending");
    const fastest = [...open]
      .sort((a, b) => velocityOf(b.window_raised, b.presale) - velocityOf(a.window_raised, a.presale) || a.presale.end_ms - b.presale.end_ms)
      .slice(0, HAPPENING_LIST_MAX);
    const today = pins.rows.flatMap(saleOf);
    const recent_presales = candidates.rows.flatMap((row) => {
      const presale = chips.get(row.presale_id);
      return row.role === "recent" && presale ? [{ presale, last_commit_ms: Number(row.sort_ms) }] : [];
    }).sort((a, b) => b.last_commit_ms - a.last_commit_ms || a.presale.presale_id.localeCompare(b.presale.presale_id));
    return { fastest, opening_soon: pending.slice(0, HAPPENING_LIST_MAX), today, ...(includeRecentPresales && { recent_presales }) };
  };
  const [[lastHour, tape, topCoins], lists] = await settledAll([
    settledAll([
      Promise.resolve().then(() => db.read<{ wallets: number; usd: string; unpriced: number }>(LAST_HOUR_SQL, [clockMs, bounds.presaleCheckpoint])),
      Promise.resolve().then(() => db.read<TapeRow>(TAPE_SQL, [clockMs, kinds, bounds.presaleCheckpoint, bounds.marketCheckpoint, HAPPENING_TAPE_MAX])),
      hidden.has("trade_buy") ? Promise.resolve(null) : readTopCoins(db, Math.min(nowMs, bounds.marketMs), nowMs, bounds.marketCheckpoint),
    ]),
    presales(),
  ]);

  return {
    clock_ms: clockMs,
    top_coins: topCoins,
    last_hour: { wallets: lastHour.rows[0]?.wallets ?? 0, usd: toUsd(lastHour.rows[0]?.usd ?? "0"), usd_complete: (lastHour.rows[0]?.unpriced ?? 0) === 0 },
    tape: tape.rows.map(tapeEvent),
    ...lists,
    as_of: asOf,
  };
}

/**
 * Share overlapping public reads within one route's service-owned source context.
 * A producer owns its database and clock until all work settles; no completed
 * answer is retained, and each caller receives an independent response object.
 */
export function createHappeningReader(database: () => ReadableDatabase, now = Date.now) {
  const share = createPublicPresaleReader(Date.now, "happening");
  return async (request: Omit<HappeningRequest, "nowMs">): Promise<SocialHappeningResponse> => {
    const config = { ...request.config };
    const hiddenKinds = [...new Set(request.hiddenKinds)].sort();
    const includeRecentPresales = request.includeRecentPresales ?? false;
    const key = JSON.stringify([config.fastest_window_ms, hiddenKinds, includeRecentPresales]);
    const response = await share(key, () => readHappening(database(), { config, hiddenKinds, includeRecentPresales, nowMs: now() }), 0);
    return structuredClone(response);
  };
}
