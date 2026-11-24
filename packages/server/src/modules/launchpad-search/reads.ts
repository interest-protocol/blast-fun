import { TEST_SUI_COIN_TYPES_SQL } from "@blast/server/modules/social/read-model/blast-launch-coins.ts";
import { z } from "zod";
import { createHash } from "node:crypto";

import type { QueryResultRow } from "pg";

import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";
import { CursorError, decodeCursor, encodeCursor, type CursorPosition, type CursorShape } from "@blast/core/modules/launchpad-contract/cursor.ts";
import type { RoutedRead } from "@blast/core/modules/launchpad-contract/read.ts";
import { SocialQueryError } from "@blast/server/modules/launchpad-social/contracts.ts";
import { LAUNCH_IDENTITY_COLUMNS, launchIdentityFromRow } from "@blast/server/modules/launchpad-social/repository.ts";
import { readChainJoin, type ChainJoinDependencies } from "@blast/server/modules/read-routing/chain-join.ts";
import type { LaunchGroup, LaunchGroupPage, LaunchMatchKind } from "@blast/core/modules/launchpad-search/contracts.ts";
import type { SearchQuery } from "@blast/server/modules/launchpad-search/query.ts";

/**
 * The launch groups' reads. Each runs one statement on the replica through
 * `readChainJoin("search")` and reads chain identity only through
 * blast-infra's `chain_read_v1` views: a launch is its curve in
 * `chain_read_v1.pools` (venue `blast_curve`, pool ID = launch ID) with its
 * coin in `chain_read_v1.coins`. A coin without a curve is no launch.
 *
 * Order is explicit, never a score: the match tier, then the newest launch
 * (the curve's creation time), then the launch ID bytewise. A page token
 * holds that position and is bound to its group and query.
 */

/** Each group's tiers: the tier number is the index. */
const TIERS: Readonly<Record<LaunchGroup, readonly LaunchMatchKind[]>> = {
  onchain: ["launch_id", "pool_id"],
  wallets: ["creator"],
  coins: ["coin_type", "ticker", "name", "words"],
};

const IDENTITY = `p.pool_id AS launch_id, ${LAUNCH_IDENTITY_COLUMNS}`;
const LAUNCH_OF_COIN = `JOIN chain_read_v1.pools p ON p.coin_type = c.coin_type AND p.venue = 'blast_curve'`;
const PUBLIC_LAUNCH = `c.coin_type NOT IN (${TEST_SUI_COIN_TYPES_SQL}) AND coalesce(p.quote_type NOT IN (${TEST_SUI_COIN_TYPES_SQL}), true)`;

/** Text in the query's search form, in SQL: NFKC, lower case, single spaces, trimmed. */
function searchForm(expression: string): string {
  return `btrim(regexp_replace(lower(normalize(${expression}, NFKC)), '\\s+', ' ', 'g'))`;
}

/** The groups a query can match: the identifier groups only for a `0x` address. */
export function applicableLaunchGroups(query: SearchQuery): LaunchGroup[] {
  return query.address === null ? ["coins"] : ["onchain", "wallets", "coins"];
}

/** A group's matching launches with their tier, `pool_venue` and `matched_pool_id`; parameters from $1. */
function groupSource(group: LaunchGroup, query: SearchQuery): Readonly<{ sql: string; values: unknown[] }> {
  switch (group) {
    case "onchain":
      return {
        sql: `SELECT ${IDENTITY}, 0 AS tier, NULL::text AS pool_venue, NULL::text AS matched_pool_id
          FROM chain_read_v1.pools p
          JOIN chain_read_v1.coins c ON c.coin_type = p.coin_type
          WHERE p.pool_key = 'blast_curve:' || $1 AND p.venue = 'blast_curve' AND ${PUBLIC_LAUNCH}
          UNION ALL
          SELECT ${IDENTITY}, 1, m.venue, m.pool_id
          FROM chain_read_v1.pools m
          JOIN chain_read_v1.pools p ON p.coin_type = m.coin_type AND p.venue = 'blast_curve'
          JOIN chain_read_v1.coins c ON c.coin_type = p.coin_type
          WHERE m.pool_id = $1 AND m.venue <> 'blast_curve' AND ${PUBLIC_LAUNCH}`,
        values: [query.address],
      };
    case "wallets":
      return {
        sql: `SELECT ${IDENTITY}, 0 AS tier, NULL::text AS pool_venue, NULL::text AS matched_pool_id
          FROM chain_read_v1.coins c
          ${LAUNCH_OF_COIN}
          WHERE c.creator = $1 AND ${PUBLIC_LAUNCH}`,
        values: [query.address],
      };
    case "coins":
      return {
        sql: `SELECT ${IDENTITY},
            CASE WHEN c.coin_type = $1 THEN 0
              WHEN ${searchForm("c.symbol")} = lower($2) THEN 1
              WHEN ${searchForm("c.name")} = lower($2) THEN 2
              ELSE 3 END AS tier,
            NULL::text AS pool_venue, NULL::text AS matched_pool_id
          FROM chain_read_v1.coins c
          ${LAUNCH_OF_COIN}
          WHERE ${PUBLIC_LAUNCH} AND (
            c.coin_type = $1
            OR ${searchForm("c.symbol")} = lower($2)
            OR ${searchForm("c.name")} = lower($2)
            OR to_tsvector('simple', normalize(concat_ws(' ', c.symbol, c.name), NFKC)) @@ to_tsquery('simple', $3)
          )`,
        values: [query.coinType, query.text, query.words],
      };
  }
}

/** A page token's shape: bound to the group and the query, keyed by tier and creation time, tie launch ID. */
export function searchCursorShape(group: LaunchGroup, query: SearchQuery): CursorShape {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([query.text, query.address, query.coinType]))
    .digest("hex")
    .slice(0, 16);
  return { scope: `search:${group}:${fingerprint}`, key: ["integer", "integer"], tie: 1 };
}

const LAUNCH_ID = SUI_OBJECT_ID_PATTERN;

/**
 * A decoded token's position, or a CursorError when it is no position of
 * this group's order: a tier the group has, a creation time from 1970 on,
 * and a launch ID tie-break. Tokens are unsigned, so this runs before any
 * read and a forged one is a 400, never a database error.
 */
function launchPosition(group: LaunchGroup, position: CursorPosition): CursorPosition {
  const [tier, createdAtMs] = position.key as readonly number[];
  if (!Number.isInteger(tier) || tier < 0 || tier >= TIERS[group].length) {
    throw new CursorError("the cursor names no tier of its group");
  }
  if (createdAtMs < 0) throw new CursorError("the cursor's creation time is negative");
  if (!z.string().regex(LAUNCH_ID).safeParse(position.tie[0]).success) throw new CursorError("the cursor's tie-break is not a launch ID");
  return position;
}

function launchMatch(group: LaunchGroup, row: QueryResultRow) {
  return {
    match: TIERS[group][row.tier],
    launch: launchIdentityFromRow(row),
    pool: row.pool_venue === null ? null : { venue: row.pool_venue, poolId: row.matched_pool_id },
  };
}

/**
 * One page of a launch group. `onchain` and `wallets` apply only to a `0x`
 * address (otherwise a SocialQueryError); a token of another group or query,
 * or one whose values are no position of this order, is a CursorError, both
 * before any read.
 */
export async function searchLaunchGroup(
  group: LaunchGroup,
  query: SearchQuery,
  request: Readonly<{ limit: number; cursor: string | null }>,
  dependencies?: ChainJoinDependencies,
): Promise<RoutedRead<LaunchGroupPage>> {
  if (!applicableLaunchGroups(query).includes(group)) throw new SocialQueryError("This search has no such group.");
  const shape = searchCursorShape(group, query);
  const after = request.cursor === null ? null : launchPosition(group, decodeCursor(request.cursor, shape));
  const source = groupSource(group, query);
  const next = source.values.length;
  return readChainJoin("search", async (database) => {
    const result = await database.read(
      `SELECT * FROM (${source.sql}) m
       WHERE $${next + 1}::int IS NULL
         OR (m.tier, -m.launch_created_at_ms, m.launch_id COLLATE "C") > ($${next + 1}::int, -$${next + 2}::bigint, $${next + 3}::text)
       ORDER BY m.tier, m.launch_created_at_ms DESC, m.launch_id COLLATE "C"
       LIMIT $${next + 4}`,
      [...source.values, after?.key[0] ?? null, after?.key[1] ?? null, after?.tie[0] ?? null, request.limit + 1],
    );
    const rows = result.rows.slice(0, request.limit);
    const last = rows.at(-1);
    return {
      items: rows.map((row) => launchMatch(group, row)),
      nextCursor: result.rows.length > request.limit && last
        ? encodeCursor(shape, [last.tier, Number(last.launch_created_at_ms)], [last.launch_id])
        : null,
    };
  }, dependencies);
}
