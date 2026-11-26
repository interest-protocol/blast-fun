import { socialParameter } from "@blast/server/modules/social/route-kit/validation.ts";
import { z } from "zod";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { coinLabel } from "@blast/core/modules/social/contracts/financial-wire.ts";
import { isHomeWindow, type HomeWindow } from "@blast/core/modules/social/contracts/home.ts";
import { invalidCursor } from "./codec.ts";
import { tinyTradeSql } from "@blast/core/modules/social/read-model/trade-size.ts";

export type ActivityStreamQuery = Readonly<{
  window: HomeWindow;
  limit: number;
  cursor: string | null;
}>;

export function parseActivityStreamQuery(
  params: URLSearchParams,
): ActivityStreamQuery {
  for (const name of params.keys()) {
    if (
      !["window", "limit", "cursor"].includes(name) ||
      params.getAll(name).length !== 1
    )
      throw new SocialRouteError("invalid_parameter", {
        extra: { parameter: name },
      });
  }
  const window = params.get("window") ?? "24h";
  if (!isHomeWindow(window))
    throw new SocialRouteError("invalid_parameter", {
      extra: { parameter: "window" },
    });
  const size = params.get("limit") ?? "20";
  socialParameter(z.string().regex(/^[1-9][0-9]*$/).transform(Number).pipe(z.number().max(50)), size, "limit");
  const cursor = params.get("cursor");
  if (cursor === "") throw invalidCursor();
  return { window, limit: Number(size), cursor };
}

import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import { walletNamingSql } from "@blast/core/modules/social/read-model/naming.ts";
import { normalizeStructTag } from "@mysten/sui/utils";
import {
  HOME_ACTIVITY_STREAM_KINDS,
  HOME_WINDOW_MS,
  type HomeActivityStreamEvent,
  type HomeActivityStreamPage,
} from "@blast/core/modules/social/contracts/home.ts";
import { actorOf, type IdentityRow } from "./aggregate.ts";
import { decodeCursor, encodeCursor } from "./codec.ts";
import { HOME_COIN_SOURCES } from "./sources.ts";
import {
  Params,
  ROW_ORDER,
  homeSpan,
  selectHome,
  type HomeBounds,
} from "./sql.ts";
import { eventOf, type EventRow } from "./thread.ts";

type Position = readonly [number, number, number, number, number];
type Traversal = Readonly<{
  window: HomeWindow;
  issuedMs: number;
  bounds: HomeBounds;
  asOf: Pick<HomeActivityStreamPage["as_of"], "checkpoint" | "timestamp_ms">;
  after: Position | null;
}>;
const TAG = "activity-stream";
const MAX_TRAVERSAL_MS = HOME_WINDOW_MS["24h"];

function cursorOf(traversal: Traversal, after: Position): string {
  return encodeCursor(TAG, [
    1,
    traversal.window,
    traversal.issuedMs,
    traversal.bounds.clockMs,
    traversal.bounds.marketCheckpoint,
    traversal.bounds.presaleCheckpoint,
    traversal.asOf.checkpoint,
    traversal.asOf.timestamp_ms,
    ...after,
  ]);
}

function traversalOf(
  cursor: string,
  window: HomeWindow,
  nowMs: number,
): Traversal {
  const values = decodeCursor(TAG, cursor);
  const parsed = z.tuple([
    z.literal(1), z.literal(window),
    z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().nonnegative(),
  ]).safeParse(values);
  if (!parsed.success) throw invalidCursor();
  const [,, issued, clock, market, presale, checkpoint, timestamp, ...last] = parsed.data;
  const issuedMs = issued as number;
  const bounds = {
    clockMs: clock as number,
    marketCheckpoint: market as number,
    presaleCheckpoint: presale as number,
  };
  const after = last as unknown as Position;
  if (
    issuedMs > nowMs ||
    bounds.clockMs > issuedMs ||
    (timestamp as number) > bounds.clockMs ||
    (checkpoint as number) >
      Math.max(bounds.marketCheckpoint, bounds.presaleCheckpoint) ||
    after[0] > bounds.clockMs ||
    after[0] <= bounds.clockMs - HOME_WINDOW_MS[window] ||
    after[1] > Math.max(bounds.marketCheckpoint, bounds.presaleCheckpoint)
  )
    throw invalidCursor();
  if (nowMs - issuedMs > MAX_TRAVERSAL_MS)
    throw new SocialRouteError("invalid_parameter", {
      extra: { parameter: "cursor", reason: "cursor_expired" },
    });
  return {
    window,
    issuedMs,
    bounds,
    asOf: {
      checkpoint: checkpoint as number,
      timestamp_ms: timestamp as number,
    },
    after,
  };
}

type StreamRow = EventRow &
  Readonly<{
    checkpoint: string;
    tx_slot: number;
    event_slot: number;
    part: number;
    actor: string;
    account_id: string | null;
    callsign: string | null;
    display_name: string | null;
    avatar_url: string | null;
    x_handle: string | null;
    verified: boolean;
    sale_coin: string;
    presale_id: string | null;
    lifecycle: string;
    sale_decimals: number;
    sale_symbol: string;
    sale_name: string;
    sale_icon_url: string | null;
  }>;

/** A time/index range and keyset+limit+1, with visibility applied before the limit.
 * Naming probes only the bounded page and re-evaluates current privacy on every read. */
async function readPage(
  db: ReadableDatabase,
  traversal: Traversal,
  limit: number,
  hiddenKinds: readonly string[],
): Promise<readonly StreamRow[]> {
  const params = new Params();
  const span = homeSpan(traversal.window, traversal.bounds);
  const from = params.add(span.fromMs),
    to = params.add(span.toMs);
  const kinds = params.add(
    HOME_ACTIVITY_STREAM_KINDS.filter((kind) => !hiddenKinds.includes(kind)),
  );
  const market = params.add(traversal.bounds.marketCheckpoint),
    presale = params.add(traversal.bounds.presaleCheckpoint);
  const after = traversal.after
    ? ` AND (a.timestamp_ms,a.checkpoint,a.tx_slot,a.event_slot,a.part) < (${traversal.after.map((value) => `${params.add(value)}::bigint`).join(",")})`
    : "";
  const size = params.add(limit + 1);
  const text = selectHome(
    `WITH stream_page AS MATERIALIZED (
    SELECT a.*, c.sale_token AS sale_coin,c.presale_id AS binding,c.lifecycle,c.sale_decimals,c.sale_symbol,c.sale_name,c.sale_icon_url,
      c.quote_type AS sale_quote,c.quote_symbol AS sale_quote_symbol,c.quote_decimals AS sale_quote_decimals
    FROM chain_read_v1.activity a JOIN ${HOME_COIN_SOURCES} c
      ON (a.presale_id IS NOT NULL AND c.presale_id=a.presale_id) OR (a.presale_id IS NULL AND c.sale_token=a.coin_type)
    WHERE a.timestamp_ms > ${from}::bigint AND a.timestamp_ms <= ${to}::bigint AND a.kind=ANY(${kinds}::text[])
      AND a.checkpoint <= CASE WHEN a.kind='presale_commit' THEN ${presale}::bigint ELSE ${market}::bigint END AND NOT ${tinyTradeSql("a")}${after}
    ORDER BY ${ROW_ORDER("a")} LIMIT ${size}::int
  )`,
    `SELECT p.*,p.binding AS presale_id,p.timestamp_ms::text AS timestamp_ms,p.checkpoint::text AS checkpoint,
    p.quote_amount::text AS quote_amount,p.coin_amount::text AS coin_amount,p.quote_refund::text AS quote_refund,p.usd_value::text AS usd_value,
    n.account_id,i.callsign,i.display_name,i.avatar_url,i.x_handle,i.verified,
    EXISTS (SELECT 1 FROM social_whys w WHERE w.entry_id='a:'||p.activity_id AND w.state='active') AS has_why
  FROM stream_page p LEFT JOIN LATERAL ${walletNamingSql("p.actor")} n ON n.named_from_ms <= p.timestamp_ms
  LEFT JOIN social_account_identities i ON i.account_id=n.account_id ORDER BY ${ROW_ORDER("p")}`,
  );
  assertChainReadThroughViews(text);
  return (await db.read<StreamRow>(text, params.values)).rows;
}

// Bounds and freshness must describe the same committed watermark observation.
// Separate autocommit reads can mint a cursor whose freshness exceeds its bounds.
async function readWatermark(db: ReadableDatabase, nowMs: number) {
  const sql = `SELECT market_checkpoint, market_timestamp_ms, presale_checkpoint, presale_timestamp_ms, observed_ms
FROM chain_read_v1.watermark`;
  assertChainReadThroughViews(sql);
  const row = (
    await db.read<{
      market_checkpoint: string | null;
      market_timestamp_ms: string | null;
      presale_checkpoint: string | null;
      presale_timestamp_ms: string | null;
      observed_ms: string | null;
    }>(sql)
  ).rows[0];
  if (
    !row ||
    row.market_checkpoint === null ||
    row.market_timestamp_ms === null ||
    row.presale_checkpoint === null ||
    row.presale_timestamp_ms === null ||
    row.observed_ms === null
  )
    throw new SocialRouteError("service_unavailable");
  const market = {
    checkpoint: Number(row.market_checkpoint),
    timestamp_ms: Number(row.market_timestamp_ms),
  };
  const presale = {
    checkpoint: Number(row.presale_checkpoint),
    timestamp_ms: Number(row.presale_timestamp_ms),
  };
  const slowest =
    market.timestamp_ms < presale.timestamp_ms ||
    (market.timestamp_ms === presale.timestamp_ms &&
      market.checkpoint < presale.checkpoint)
      ? market
      : presale;
  return {
    bounds: {
      marketCheckpoint: market.checkpoint,
      presaleCheckpoint: presale.checkpoint,
      clockMs: Math.min(
        nowMs,
        Math.max(market.timestamp_ms, presale.timestamp_ms),
      ),
    },
    freshness: slowest,
    observedMs: Number(row.observed_ms),
  };
}

export async function readHomeActivityStream(
  db: ReadableDatabase,
  query: ActivityStreamQuery,
  context: Readonly<{
    nowMs: number;
    hiddenKinds: readonly string[];
    network?: HomeActivityStreamEvent["coin"]["network"];
  }>,
): Promise<HomeActivityStreamPage> {
  const saved =
    query.cursor === null
      ? null
      : traversalOf(query.cursor, query.window, context.nowMs);
  const {
    bounds: current,
    freshness,
    observedMs,
  } = await readWatermark(db, context.nowMs);
  if (
    saved &&
    (saved.bounds.clockMs > current.clockMs ||
      saved.bounds.marketCheckpoint > current.marketCheckpoint ||
      saved.bounds.presaleCheckpoint > current.presaleCheckpoint)
  )
    throw invalidCursor();
  const traversal: Traversal =
    saved === null
      ? {
          window: query.window,
          issuedMs: context.nowMs,
          bounds: current,
          asOf: freshness,
          after: null,
        }
      : saved;
  const rows = await readPage(
    db,
    traversal,
    query.limit,
    context.hiddenKinds,
  );
  const page = rows.slice(0, query.limit);
  const events = page.map((row) => {
    const event = eventOf(row)!;
    const identities = new Map<string, IdentityRow>();
    if (row.account_id !== null)
      identities.set(row.account_id, { ...row, account_id: row.account_id });
    return {
      ...event,
      kind: row.kind as HomeActivityStreamEvent["kind"],
      actor: actorOf(
        { account_id: row.account_id, wallet: row.actor },
        identities,
      ),
      coin: {
        chain: "sui" as const,
        network: context.network ?? "mainnet",
        coin_type: normalizeStructTag(row.sale_coin),
        presale_id: row.presale_id,
        lifecycle: row.lifecycle,
        decimals: row.sale_decimals,
        ...coinLabel({ coinType: row.sale_coin, symbol: row.sale_symbol, name: row.sale_name }),
        icon_url: row.sale_icon_url,
      },
    };
  });
  const last = page.at(-1);
  return {
    window: query.window,
    from_ms: traversal.bounds.clockMs - HOME_WINDOW_MS[query.window],
    to_ms: traversal.bounds.clockMs,
    clock_ms: traversal.bounds.clockMs,
    events,
    next_cursor:
      rows.length > query.limit && last
        ? cursorOf(traversal, [
            Number(last.timestamp_ms),
            Number(last.checkpoint),
            Number(last.tx_slot),
            Number(last.event_slot),
            Number(last.part),
          ])
        : null,
    as_of: {
      ...traversal.asOf,
      lag_ms: Math.max(0, observedMs - traversal.asOf.timestamp_ms),
    },
  };
}
