import { CRON_ROUTES } from "@blast/core/modules/backend-api/cron-routes.ts";
import { CLEANUP_TABLES } from "@blast/core/modules/mission-control/maintenance/contracts.ts";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";

const [cleanupPath] = CRON_ROUTES;

const report = {
  complete: Schema.Boolean,
  durationMs: Schema.Finite,
  tables: Schema.Record(
    Schema.Literals(CLEANUP_TABLES),
    Schema.Struct({
      batches: Schema.Finite,
      complete: Schema.Boolean,
      deleted: Schema.Finite,
      durationMs: Schema.Finite,
      error: Schema.optionalKey(Schema.String),
    }),
  ),
};

const cleanupSucceeded = Schema.Struct({ ...report, ok: Schema.Literal(true) });

const cleanupFailed = Schema.Struct({
  ...report,
  ok: Schema.Literal(false),
  error: Schema.Struct({
    code: Schema.Literal("CLEANUP_FAILED"),
    message: Schema.String,
  }),
}).pipe(HttpApiSchema.status(500));

const cleanupUnavailable = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Literal("CLEANUP_UNAVAILABLE"),
    message: Schema.String,
  }),
}).pipe(HttpApiSchema.status(503));

export const CronHttpApi = HttpApi.make("blast-cron").add(
  HttpApiGroup.make("cron").add(
    HttpApiEndpoint.get("cleanup", cleanupPath, {
      success: cleanupSucceeded,
      error: [cleanupFailed, cleanupUnavailable],
    }),
    HttpApiEndpoint.head("cleanupHead", cleanupPath, {
      success: HttpApiSchema.Empty(200),
      error: [HttpApiSchema.Empty(500), HttpApiSchema.Empty(503)],
    }),
  ),
);
