import type { Pool } from "pg";
import {
  autocommitWrite,
  type ReadableDatabase,
} from "@blast/core/modules/database/transaction.ts";
import type { AuthorizedOperator } from "../../mission-control/operator/auth.ts";
import { competitionInput } from "@blast/core/modules/social/competitions/config.ts";
import { TEST_SUI_COIN_TYPES_SQL, TEST_SUI_LAUNCH_TYPES } from "../read-model/blast-launch-coins.ts";
import { readTradeCoins } from "../trades/coins.ts";
import {
  COMPETITION_PAGE_SIZE,
  type Competition,
  type CompetitionBoard,
  type CompetitionMember,
  type CompetitionPeriod,
  type CompetitionViewerRank,
  type SwapCompetitions,
} from "@blast/core/modules/social/competitions/contracts.ts";

const CONFIG_COLUMNS =
  "slug, name, coin_type, coin_symbol, coin_icon_url, feature_on_swap, prize_description, trim_scale(prize_amount)::text AS prize_amount, prize_coin_type, prize_coin_symbol, rules_url, starts_at_ms::float8, ends_at_ms::float8, rules_version";

const SWAP_PLACEMENTS = `SELECT * FROM social_competitions competition
  WHERE feature_on_swap AND coin_type NOT IN (${TEST_SUI_COIN_TYPES_SQL})
    AND NOT EXISTS (SELECT 1 FROM ${TEST_SUI_LAUNCH_TYPES} blocked WHERE blocked.coin_type = competition.coin_type)`;

/** Future-only, append-only configuration. Audit identity is stored with the rules. */
export async function createCompetition(
  pool: Pool,
  raw: unknown,
  operator: AuthorizedOperator,
): Promise<Competition> {
  const input = competitionInput.parse(raw);
  if (input.starts_at_ms <= Date.now()) throw new Error("Competition must start in the future");
  const result = await autocommitWrite<"social", Competition>(
    pool,
    "social",
    "social_competitions",
    `INSERT INTO social_competitions (slug, name, coin_type, coin_symbol, prize_description, rules_url, starts_at_ms, ends_at_ms, created_by, coin_icon_url, feature_on_swap,
       prize_amount, prize_coin_type, prize_coin_symbol)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::numeric, $13, $14) RETURNING ${CONFIG_COLUMNS}`,
    [
      input.slug,
      input.name,
      input.coin_type,
      input.coin_symbol,
      input.prize_description,
      input.rules_url,
      input.starts_at_ms,
      input.ends_at_ms,
      `operator:${operator.operatorId}`,
      input.coin_icon_url,
      input.feature_on_swap,
      input.prize_amount,
      input.prize_coin_type,
      input.prize_coin_symbol,
    ],
  );
  return result.rows[0];
}

/** Public configuration only; never reads private receipts or member identities. */
export async function readSwapCompetitions(
  db: ReadableDatabase,
  nowMs = Date.now(),
): Promise<SwapCompetitions> {
  const [events, boundary] = await Promise.all([
    db.read<Competition>(
      `SELECT ${CONFIG_COLUMNS} FROM (
        SELECT DISTINCT ON (coin_type) * FROM (${SWAP_PLACEMENTS}) placement
        WHERE starts_at_ms <= $1::bigint AND ends_at_ms > $1::bigint
        ORDER BY coin_type, starts_at_ms, slug
      ) live ORDER BY starts_at_ms, slug LIMIT $2`,
      [nowMs, COMPETITION_PAGE_SIZE],
    ),
    db.read<{ next_change_at_ms: number | null }>(
      `SELECT min(CASE WHEN starts_at_ms > $1::bigint THEN starts_at_ms ELSE ends_at_ms END)::float8 AS next_change_at_ms
       FROM (${SWAP_PLACEMENTS}) placement WHERE ends_at_ms > $1::bigint`,
      [nowMs],
    ),
  ]);
  const metadata = events.rows.length
    ? await readTradeCoins(
        db,
        events.rows.map((event) => event.coin_type),
        nowMs,
      )
    : new Map();
  return {
    competitions: events.rows,
    coins: events.rows.flatMap((event) => {
      const coin = metadata.get(event.coin_type);
      return coin
        ? [
            {
              coin_type: coin.coinType,
              symbol: coin.symbol,
              name: coin.symbol,
              decimals: coin.decimals,
              usd_price: coin.usdPrice,
              presale_id: coin.presaleId,
              icon_url: event.coin_icon_url,
            },
          ]
        : [];
    }),
    as_of_ms: nowMs,
    next_change_at_ms: boundary.rows[0]?.next_change_at_ms ?? null,
  };
}

export async function listCompetitions(
  db: ReadableDatabase,
  page: number,
  period?: CompetitionPeriod,
  nowMs = Date.now(),
) {
  const { rows } = await db.read<Competition>(
    `SELECT ${CONFIG_COLUMNS} FROM social_competitions
    WHERE $3::text IS NULL
      OR ($3 = 'current' AND ends_at_ms > $4::bigint)
      OR ($3 = 'past' AND ends_at_ms <= $4::bigint)
    ORDER BY starts_at_ms DESC, slug LIMIT $1 OFFSET $2`,
    [COMPETITION_PAGE_SIZE + 1, (page - 1) * COMPETITION_PAGE_SIZE, period ?? null, nowMs],
  );
  return {
    competitions: rows.slice(0, COMPETITION_PAGE_SIZE),
    page,
    has_more: rows.length > COMPETITION_PAGE_SIZE,
    as_of_ms: nowMs,
  };
}

export async function findCompetition(
  db: ReadableDatabase,
  slug: string,
): Promise<Competition | null> {
  const { rows } = await db.read<Competition>(
    `SELECT ${CONFIG_COLUMNS} FROM social_competitions WHERE slug = $1`,
    [slug],
  );
  return rows[0] ?? null;
}

// The receipt's chain time scopes the window. Intent account_id fixes attribution:
// a subsequently linked/reassigned address never claims someone else's swaps.
// Live privacy and ownership are checked on the primary, without a public cache.
// OR selects the transaction once, even if the coin appears on both sides.
// One ranked board: the leaderboard's page and the viewer's own row read the same ranks.
const RANKED_BOARD_SQL = `SELECT account_id::text, callsign, display_name, avatar_url,
    CASE WHEN volume_usd IS NOT NULL THEN position::int ELSE NULL END AS rank,
    volume_usd, swaps::int, unpriced_swaps::int, addresses
  FROM (
    SELECT totals.*, identity.callsign, identity.display_name, identity.avatar_url,
      rank() OVER (ORDER BY volume_usd DESC NULLS LAST) AS position
    FROM (
      SELECT i.account_id, sum(i.usd_value) AS volume_usd, count(*) AS swaps,
        count(*) FILTER (WHERE i.usd_value IS NULL) AS unpriced_swaps,
        array_agg(DISTINCT i.sender ORDER BY i.sender) AS addresses
      FROM social_swap_receipts r
      JOIN social_swap_intents i USING (trade_id)
      JOIN social_accounts a ON a.account_id = i.account_id
      JOIN social_wallet_owners owner ON owner.account_id = i.account_id AND owner.address = i.sender
      WHERE r.success AND i.track_receipt
        AND r.timestamp_ms >= $1::bigint AND r.timestamp_ms < $2::bigint AND r.timestamp_ms <= $4::bigint
        AND (i.in_coin = $3 OR i.out_coin = $3)
        AND a.privacy = 'public' AND a.sharing_since IS NOT NULL
        AND extract(epoch FROM a.sharing_since) * 1000 <= r.timestamp_ms
        AND extract(epoch FROM owner.linked_at) * 1000 <= r.timestamp_ms
      GROUP BY i.account_id
    ) totals
    JOIN social_account_identities identity USING (account_id)
    WHERE identity.callsign IS NOT NULL
  ) ranked`;

const BOARD_COLUMNS = "board.account_id, board.callsign, board.display_name, board.avatar_url, board.rank, board.volume_usd::text, board.swaps, board.unpriced_swaps, board.addresses";

/**
 * `rows` of the board ranked once (the CTE, inside a `SELECT`: a read takes nothing else), always one row: the board's member count (`members_total`, the
 * "Traders" tile) beside the chosen members, whose columns are null when none is chosen (a page past the end,
 * a viewer the board does not count).
 */
const countedBoardSql = (rows: string) => `SELECT counted.* FROM (
  WITH ranked_board AS MATERIALIZED (${RANKED_BOARD_SQL})
  SELECT (SELECT count(*)::int FROM ranked_board) AS members_total, ${BOARD_COLUMNS}
  FROM (SELECT 1) one
  LEFT JOIN LATERAL (${rows}) board ON TRUE
) counted`;

const LEADERBOARD_SQL = countedBoardSql(`SELECT * FROM ranked_board
  ORDER BY ranked_board.volume_usd DESC NULLS LAST, ranked_board.account_id
  LIMIT $5 OFFSET $6`);

/** The viewer's row ($5), ranked among every member of the same board. */
const VIEWER_RANK_SQL = countedBoardSql(`SELECT * FROM ranked_board WHERE ranked_board.account_id = $5::uuid::text`);

/** A `countedBoardSql` row: a member's columns, all null on the row that chose none (`account_id` says which). */
type CountedBoardRow = Omit<CompetitionMember, "account_id"> & Readonly<{ account_id: string | null; members_total: number }>;

/** The member count and the chosen members of a `countedBoardSql` answer. */
function countedBoard(rows: readonly CountedBoardRow[]): Readonly<{ members_total: number; members: CompetitionMember[] }> {
  return {
    members_total: rows[0]?.members_total ?? 0,
    members: rows.flatMap((row): CompetitionMember[] => (row.account_id === null ? [] : [{
      account_id: row.account_id,
      callsign: row.callsign,
      display_name: row.display_name,
      avatar_url: row.avatar_url,
      rank: row.rank,
      volume_usd: row.volume_usd,
      swaps: row.swaps,
      unpriced_swaps: row.unpriced_swaps,
      addresses: row.addresses,
    }])),
  };
}

/** Redesign gap 15: the viewer's own row of the board, or null when the board does not count them. */
export async function readCompetitionViewerRank(
  db: ReadableDatabase,
  competition: Competition,
  accountId: string,
  nowMs = Date.now(),
): Promise<CompetitionViewerRank> {
  const { rows } = await db.read<CountedBoardRow>(VIEWER_RANK_SQL, [competition.starts_at_ms, competition.ends_at_ms, competition.coin_type, nowMs, accountId]);
  const { members_total, members } = countedBoard(rows);
  return { competition, member: members[0] ?? null, members_total, as_of_ms: nowMs, usd_basis: "input_value_at_submission" };
}

export async function readCompetitionBoard(
  db: ReadableDatabase,
  competition: Competition,
  page: number,
  nowMs = Date.now(),
): Promise<CompetitionBoard> {
  const { rows } = await db.read<CountedBoardRow>(LEADERBOARD_SQL, [
    competition.starts_at_ms,
    competition.ends_at_ms,
    competition.coin_type,
    nowMs,
    COMPETITION_PAGE_SIZE + 1,
    (page - 1) * COMPETITION_PAGE_SIZE,
  ]);
  const { members_total, members } = countedBoard(rows);
  return {
    competition,
    members: members.slice(0, COMPETITION_PAGE_SIZE),
    members_total,
    page,
    has_more: members.length > COMPETITION_PAGE_SIZE,
    as_of_ms: nowMs,
    usd_basis: "input_value_at_submission",
  };
}
