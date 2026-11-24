import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { HOME_WINDOW_MS, type HomeDexVolume, type HomeWindow } from "@blast/core/modules/social/contracts/home.ts";
import { INDEXED_POOL_COINS } from "@blast/core/modules/social/portfolio/core-coins.ts";

import type { HomeBounds } from "./sql.ts";

const TRACKED_POOL_TYPES = new Set<string>(INDEXED_POOL_COINS.map((coin) => coin.coinType));

function volumeSql(includeTracked: boolean): string {
  return `SELECT c.coin_type,
  trim_scale(sum(s.usd_value))::text AS usd,
  trim_scale(sum(s.usd_value) FILTER (WHERE s.venue = 'cetus'))::text AS cetus_usd,
  trim_scale(sum(s.usd_value) FILTER (WHERE s.venue = 'bluefin'))::text AS bluefin_usd,
  c.window_complete AND count(s.venue) FILTER (WHERE s.usd_value IS NULL) = 0 AS complete,
  c.window_complete AND count(s.venue) FILTER (WHERE s.usd_value IS NULL AND s.venue = 'cetus') = 0 AS cetus_complete,
  c.window_complete AND count(s.venue) FILTER (WHERE s.usd_value IS NULL AND s.venue = 'bluefin') = 0 AS bluefin_complete
FROM (
  SELECT coin_type, bool_or(window_complete) AS window_complete
  FROM (
    SELECT coin_type, TRUE AS window_complete
    FROM unnest($1::text[]) AS native(coin_type)
    CROSS JOIN chain_read_v1.dex_swap_volume_coverage coverage
    WHERE coverage.started_at_ms <= $2::bigint AND coverage.checkpoint >= $4::bigint
    ${includeTracked ? `UNION ALL
    SELECT coin_type, coverage.started_at_ms <= $2::bigint AS window_complete
    FROM unnest($5::text[]) AS tracked(coin_type)
    CROSS JOIN chain_read_v1.dex_swap_volume_tracked_coverage coverage
    WHERE coverage.checkpoint >= $4::bigint` : ""}
  ) eligible
  GROUP BY coin_type
) c
LEFT JOIN chain_read_v1.dex_swap_volume s ON s.coin_type = c.coin_type
  AND s.timestamp_ms > $2::bigint AND s.timestamp_ms <= $3::bigint AND s.checkpoint <= $4::bigint
  AND s.venue IN ('cetus', 'bluefin')
GROUP BY c.coin_type, c.window_complete`;
}

const VOLUME_SQL = volumeSql(false);
const TRACKED_VOLUME_SQL = volumeSql(true);
assertChainReadThroughViews(VOLUME_SQL);
assertChainReadThroughViews(TRACKED_VOLUME_SQL);

type VolumeRow = Readonly<{
  coin_type: string;
  usd: string | null;
  cetus_usd: string | null;
  bluefin_usd: string | null;
  complete: boolean;
  cetus_complete: boolean;
  bluefin_complete: boolean;
}>;

function pricedVolume(usd: string | null, complete: boolean): HomeDexVolume["venues"]["cetus"] {
  return { usd: complete ? usd ?? "0" : usd, usd_complete: complete };
}

/** Tracked coins can show priced swaps while their coverage fills the requested window. */
export async function readDexVolumes(
  db: ReadableDatabase,
  coins: readonly Readonly<{ coin_type: string; tracked_pool_only: boolean }>[],
  window: HomeWindow,
  bounds: HomeBounds,
  kinds: readonly string[],
): Promise<ReadonlyMap<string, HomeDexVolume>> {
  const toMs = bounds.dexClockMs;
  if (toMs === undefined || coins.length === 0 || !kinds.includes("trade_buy") || !kinds.includes("trade_sell")) {
    return new Map();
  }
  const native = coins.filter((coin) => !coin.tracked_pool_only).map((coin) => coin.coin_type);
  const tracked = bounds.hasTrackedDexVolume
    ? coins.filter((coin) => TRACKED_POOL_TYPES.has(coin.coin_type)).map((coin) => coin.coin_type)
    : [];
  if (native.length === 0 && tracked.length === 0) return new Map();
  const values = [native, toMs - HOME_WINDOW_MS[window], toMs, bounds.marketCheckpoint];
  const { rows } = tracked.length > 0
    ? await db.read<VolumeRow>(TRACKED_VOLUME_SQL, [...values, tracked])
    : await db.read<VolumeRow>(VOLUME_SQL, values);
  return new Map(rows.map((row) => [row.coin_type, {
    ...pricedVolume(row.usd, row.complete),
    venues: {
      cetus: pricedVolume(row.cetus_usd, row.cetus_complete),
      bluefin: pricedVolume(row.bluefin_usd, row.bluefin_complete),
    },
  }]));
}
