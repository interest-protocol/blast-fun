import { ACTIVITY_HINT_PATH } from "@blast/core/modules/backend-api/private/social-stream-contracts.ts";
import { MARKET_STREAM_PATH } from "@blast/core/modules/launchpad-contract/market-stream.ts";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import * as Schema from "effect/Schema";

const streamHeaders = {
  "cache-control": Schema.Literals(["no-store", "private, no-store"]),
  "x-accel-buffering": Schema.Literal("no"),
};
const stream = HttpApiSchema.WithHeaders(
  HttpApiSchema.StreamUint8Array({ contentType: "text/event-stream" }),
  streamHeaders,
);
const head = HttpApiSchema.WithHeaders(HttpApiSchema.Empty(200), {
  ...streamHeaders,
  "content-type": Schema.Literal("text/event-stream"),
});
const hintError = Schema.Struct({
  error: Schema.Struct({ code: Schema.String, message: Schema.String }),
});
const errors = [400, 403, 429, 499, 500, 503].map((status) =>
  HttpApiSchema.status(status)(hintError),
);

export const HintsApi = HttpApi.make("blastHints").add(
  HttpApiGroup.make("hints").add(
    HttpApiEndpoint.get("activity", ACTIVITY_HINT_PATH, { success: stream, error: errors }),
    HttpApiEndpoint.head("activityHead", ACTIVITY_HINT_PATH, { success: head, error: errors }),
    HttpApiEndpoint.get("market", MARKET_STREAM_PATH, { success: stream, error: errors }),
    HttpApiEndpoint.head("marketHead", MARKET_STREAM_PATH, { success: head, error: errors }),
  ),
);
