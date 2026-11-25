import { PRIVATE_ROUTES } from "@blast/core/modules/backend-api/private-routes.ts";
import * as Schema from "effect/Schema";
import * as HttpMethod from "effect/http/HttpMethod";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";

export const privateEndpoints = PRIVATE_ROUTES.map(({ id, method, path }) => {
  if (!HttpMethod.isHttpMethod(method)) {
    throw new Error(`Unsupported private HTTP method ${method}.`);
  }
  return {
    id,
    endpoint: HttpApiEndpoint.make(method)(`${id}.${method.toLowerCase()}`, path, {
      success: Schema.Unknown,
    }),
  };
});

const [first, ...remaining] = privateEndpoints.map(({ endpoint }) => endpoint);
if (!first) {
  throw new Error("Missing private HTTP contracts.");
}

export const PrivateApi = HttpApi.make("blast-private").add(
  HttpApiGroup.make("private").add(first, ...remaining),
);
