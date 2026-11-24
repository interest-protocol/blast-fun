import { OPERATOR_ROUTES } from "@blast/core/modules/backend-api/operator-routes.ts";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as Schema from "effect/Schema";

const response = { success: Schema.Unknown } as const;

// Admission allows these three methods across the namespace. Each owner keeps
// its original refusal for methods it does not support.
export const operatorEndpoints = OPERATOR_ROUTES.flatMap(({ id, path }) => [
  { id, endpoint: HttpApiEndpoint.get(`${id}.get` as const, path, response) },
  { id, endpoint: HttpApiEndpoint.post(`${id}.post` as const, path, response) },
  { id, endpoint: HttpApiEndpoint.put(`${id}.put` as const, path, response) },
]);

const [first, ...remaining] = operatorEndpoints.map(({ endpoint }) => endpoint);
if (!first) {
  throw new Error("Missing operator HTTP contracts.");
}

export const OperatorApi = HttpApi.make("blast-operators").add(
  HttpApiGroup.make("operators").add(first, ...remaining),
);
