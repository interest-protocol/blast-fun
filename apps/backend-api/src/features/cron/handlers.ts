import { publicJson } from "@blast/core/lib/http-errors.ts";
import type { CleanupReport } from "@blast/core/modules/mission-control/maintenance/contracts.ts";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { CronHttpApi } from "../../data/api/cron/CronHttpApi.ts";

const headers = { "Cache-Control": "no-store" };

export function cronHandlers(cleanup: () => Promise<CleanupReport>) {
  const run = Effect.tryPromise({ try: cleanup, catch: (error) => error });
  const respond = () =>
    Effect.match(run, {
      onSuccess: (report) =>
        report.ok
          ? publicJson(report, { headers })
          : publicJson(
              {
                ...report,
                error: {
                  code: "CLEANUP_FAILED",
                  message: "Some cleanup steps failed. Check the reference ID in server logs.",
                },
              },
              { status: 500, headers },
            ),
      onFailure: (cause) =>
        publicJson(
          {
            error: {
              code: "CLEANUP_UNAVAILABLE",
              message: "Cleanup is temporarily unavailable.",
            },
          },
          { status: 503, headers },
          cause,
        ),
    }).pipe(
      Effect.map((response) => HttpServerResponse.raw(response, { status: response.status })),
    );

  // The transport may answer early after cancellation. Keep the cleanup permit until
  // the bounded database operation settles, including for HEAD requests.
  const options = { uninterruptible: true };
  return HttpApiBuilder.group(CronHttpApi, "cron", (handlers) =>
    handlers.handle("cleanup", respond, options).handle("cleanupHead", respond, options),
  );
}
