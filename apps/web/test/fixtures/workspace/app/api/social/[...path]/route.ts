import { testClient } from "../../../../../../../../../packages/core/test/fixtures/lib/web-security/client-address.ts";
import {
  presaleDetail,
  presaleViewer,
  presaleId,
} from "../../../../presale-fixtures";
import {
  coinRows,
  homeCoinRows,
  history,
  holderSample,
} from "../../../../coin-fixtures";

/** Test application only: shaped public reads, no production endpoint or chain effect. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.pathname === "/api/social/competitions" && url.searchParams.get("placement") === "swap") {
    return Response.json({ competitions: [], coins: [], as_of_ms: Date.now(), next_change_at_ms: null });
  }
  if (url.pathname === "/api/social/home/activity-stream") return Response.json({ events: [], next_cursor: null, window: "24h", clock_ms: Date.now(), as_of: { checkpoint: 1, timestamp_ms: Date.now(), lag_ms: 0 } });
  const presaleIds = new Set(url.searchParams.getAll("presale"));
  if (process.env.T020_CONFIG_DIR) {
    const source = await import("../../../../portfolio/server");
    if (url.pathname === "/api/social/trades/coins")
      return source.tradeCoins(request, testClient());
    if (url.pathname === "/api/social/home/coins")
      return source.home.COINS(request, testClient());
  }
  if (url.pathname === `/api/social/presales/${presaleId}`)
    return Response.json(presaleDetail());
  if (
    url.pathname === "/api/social/home" ||
    url.pathname === "/api/social/home/coins"
  )
    return Response.json({
      coins: homeCoinRows.filter(
        (row) =>
          url.pathname === "/api/social/home" ||
          presaleIds.has(row.presale_id ?? ""),
      ),
      page: 1,
      pages: 1,
      total: homeCoinRows.length,
      window: "24h",
      missing: [],
      next_cursor: null,
      clock_ms: 1790337660000,
      as_of: { checkpoint: 1, timestamp_ms: 1790337660000, lag_ms: 0 },
    });
  if (url.pathname === "/api/social/trades/coins")
    return Response.json({
      coins: coinRows.filter(
        (row) =>
          row.presale_id !== null &&
          row.coin_type === url.searchParams.get("q"),
      ),
      next_cursor: null,
    });
  if (url.pathname === "/api/social/prices")
    return Response.json({
      prices: coinRows
        .filter(
          (row) =>
            row.coin_type === url.searchParams.get("coin") ||
            (row.presale_id !== null &&
              row.presale_id === url.searchParams.get("presale")),
        )
        .map((row) => history(row.coin_type)),
      as_of: {},
    });
  if (url.pathname === "/api/social/home/activity")
    return Response.json({
      presale_id: url.searchParams.get("presale"),
      participants: [],
      totals: {},
      as_of: {},
      next_cursor: null,
      window: "24h",
      clock_ms: 1790337660000,
    });
  return Response.json({
    coins: coinRows
      .filter(
        (row) =>
          url.pathname !== "/api/social/home/coins" ||
          presaleIds.has(row.presale_id ?? ""),
      )
      .map((row) => ({ ...row, top_holders: holderSample })),
    missing: [],
    clock_ms: 1790337660000,
    as_of: {},
    next_cursor: null,
  });
}

export function POST(request: Request) {
  if (new URL(request.url).pathname === "/api/social/presales/viewer")
    return Response.json({
      presales: { [presaleId]: presaleViewer },
      rows: null,
    });
  return new Response(null, { status: 404 });
}
