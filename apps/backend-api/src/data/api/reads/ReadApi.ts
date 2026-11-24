import { NON_MARKET_READ_ROUTES } from "@blast/core/modules/backend-api/public-read-routes.ts";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";

export const readEndpoints = NON_MARKET_READ_ROUTES.flatMap((route) => [
  {
    route,
    endpoint: HttpApiEndpoint.get(`${route.name}.get` as const, route.path, {
      success: Schema.Unknown,
    }),
  },
  {
    route,
    endpoint: HttpApiEndpoint.head(`${route.name}.head` as const, route.path, {
      success: HttpApiSchema.Empty(200),
    }),
  },
]);

const [first, ...remaining] = readEndpoints.map(({ endpoint }) => endpoint);
if (!first) {
  throw new Error("Missing public read HTTP contracts.");
}

export const ReadApi = HttpApi.make("blast-reads").add(
  HttpApiGroup.make("reads").add(first, ...remaining),
);
