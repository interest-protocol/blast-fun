import { publicErrorResponse } from "@blast/core/lib/http-errors.ts";
import {
  dayInterval,
  DefillamaError,
  type DailyLaunchStats,
} from "@blast/core/modules/defillama/contracts.ts";
import { defillamaReportingReads } from "@blast/core/modules/defillama/runtime.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { publicReadCache } from "@blast/server/modules/public-reads/shared-runtime.ts";

async function readPublishedDailyStats(
  date: string,
): Promise<DailyLaunchStats> {
  const settings = runtimeConfig().defillama;
  const store = defillamaReportingReads(settings);
  return publicReadCache("market")(
    `partner:daily-stats:v1:${JSON.stringify(settings?.profile)}:${date}`,
    async () => {
      const { summary } = await store.publication({ date });
      if (!summary.daily_launch_stats) {
        throw new DefillamaError("not_published", 404);
      }
      return summary.daily_launch_stats;
    },
    10_000,
  );
}

export async function handleDailyStatsRequest(
  request: Request,
  read = readPublishedDailyStats,
  now = Date.now(),
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const date = params.get("date");
  if (date === null || params.size !== 1) {
    return publicErrorResponse(
      "invalid_parameters",
      "Provide one date in YYYY-MM-DD format.",
      400,
    );
  }

  try {
    dayInterval(date, now);
    return Response.json({ date, ...(await read(date)) });
  } catch (cause) {
    if (cause instanceof DefillamaError) {
      if (cause.code === "invalid_date") {
        return publicErrorResponse(
          "invalid_date",
          "Provide a valid date in YYYY-MM-DD format.",
          400,
        );
      }
      if (cause.code === "day_not_complete") {
        return publicErrorResponse(
          "day_not_complete",
          "Daily stats cover completed UTC days.",
          409,
        );
      }
      if (cause.code === "not_published") {
        return publicErrorResponse(
          "daily_stats_not_published",
          "Daily stats have not been published for this date.",
          404,
        );
      }
    }
    return publicErrorResponse(
      "daily_stats_unavailable",
      "Daily stats are temporarily unavailable.",
      503,
      { cause },
    );
  }
}
