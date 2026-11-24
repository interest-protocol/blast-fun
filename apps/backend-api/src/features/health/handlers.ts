import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import {
  HealthApi,
  LIVENESS_BODY,
  READY_BODY,
  UNAVAILABLE_BODY,
} from "../../data/api/health/HealthApi.ts";

const live = () => Effect.succeed<typeof LIVENESS_BODY>(LIVENESS_BODY);

export const livenessHandlers = HttpApiBuilder.group(HealthApi, "liveness", (handlers) =>
  handlers
    .handle("get", live)
    .handle("head", () =>
      // HEAD carries the GET length even though the listener sends no body.
      Effect.succeed(
        HttpServerResponse.empty({
          status: 200,
          headers: { "content-length": String(LIVENESS_BODY.length) },
        }),
      ),
    )
    .handle("options", live),
);

export function readinessHandlers(ready: () => Promise<boolean>) {
  return HttpApiBuilder.group(HealthApi, "readiness", (handlers) => {
    // Preserve native Fetch headers. Encoding the string would add Content-Length.
    const respond = () =>
      Effect.map(Effect.promise(ready), (passed) => {
        const status = passed ? 200 : 503;
        return HttpServerResponse.raw(
          new Response(passed ? READY_BODY : UNAVAILABLE_BODY, { status }),
          { status },
        );
      });
    // A client disconnect must not release a readiness permit before shared work settles.
    const options = { uninterruptible: true };
    return handlers
      .handle("get", respond, options)
      .handle("head", respond, options)
      .handle("options", respond, options);
  });
}
