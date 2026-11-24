import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";

export const LIVENESS_PATH = "/v1/live";

export const READINESS_PATH = "/v1/health";

export const LIVENESS_BODY = "live";

export const READY_BODY = "ready";

export const UNAVAILABLE_BODY = "unavailable";

const success = Schema.Literal(LIVENESS_BODY).pipe(
  HttpApiSchema.asText({ contentType: "application/octet-stream" }),
);

const readiness = {
  success: Schema.Literal(READY_BODY).pipe(HttpApiSchema.asText()),
  error: Schema.Literal(UNAVAILABLE_BODY).pipe(HttpApiSchema.asText(), HttpApiSchema.status(503)),
};

export const HealthApi = HttpApi.make("blast-health").add(
  HttpApiGroup.make("liveness").add(
    HttpApiEndpoint.get("get", LIVENESS_PATH, { success }),
    HttpApiEndpoint.head("head", LIVENESS_PATH, { success: HttpApiSchema.Empty(200) }),
    HttpApiEndpoint.options("options", LIVENESS_PATH, { success }),
  ),
  HttpApiGroup.make("readiness").add(
    HttpApiEndpoint.get("get", READINESS_PATH, readiness),
    HttpApiEndpoint.head("head", READINESS_PATH, {
      success: HttpApiSchema.Empty(200),
      error: HttpApiSchema.Empty(503),
    }),
    HttpApiEndpoint.options("options", READINESS_PATH, readiness),
  ),
);
