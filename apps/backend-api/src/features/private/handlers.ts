import { publicErrorResponse } from "@blast/core/lib/http-errors.ts";
import { trackRequestWork } from "@blast/server/lib/request-work.ts";
import {
  withErrorBoundary,
  type PrivateContext,
  type PrivateHandlers,
} from "@blast/server/private/handler.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { PrivateApi, privateEndpoints } from "../../data/api/private/PrivateApi.ts";

export class PrivateRequest extends Context.Service<
  PrivateRequest,
  { request: Request; context: PrivateContext }
>()("blast/backend-api/private/PrivateRequest") {}

export const privateHandlers = (operations: PrivateHandlers) =>
  HttpApiBuilder.group(PrivateApi, "private", (handlers) => {
    type Identifier = (typeof privateEndpoints)[number]["endpoint"]["identifier"];
    const bindings = Object.fromEntries(
      privateEndpoints.map(({ id, endpoint }) => {
        const operation = Object.hasOwn(operations, id) ? operations[id] : undefined;
        if (!operation) {
          throw new Error(`Missing private owner for ${id}.`);
        }
        const handle = withErrorBoundary(operation);
        return [
          endpoint.identifier,
          {
            handler: () =>
              Effect.gen(function* () {
                const { request, context } = yield* PrivateRequest;
                // The exact Bun admission match controls capabilities. The
                // router must never select another action for the same URL.
                if (
                  context.proof.route.id !== id ||
                  context.proof.route.method !== request.method
                ) {
                  return wireResponse(publicErrorResponse("not_found", "Not found.", 404));
                }
                const response = yield* Effect.promise(() => handle(request, context));
                if (request.method === "HEAD" && response.body) {
                  // HttpApi omits HEAD bodies. Retain ownership until the
                  // discarded body cancels, without delaying the response.
                  trackRequestWork(response.body.cancel().catch(() => undefined));
                }
                return wireResponse(response);
              }),
            options: { uninterruptible: true },
          },
        ] as const;
      }),
    ) as Record<
      Identifier,
      {
        handler: () => Effect.Effect<HttpServerResponse.HttpServerResponse, never, PrivateRequest>;
        options: { uninterruptible: true };
      }
    >;
    return handlers.handleAll(bindings);
  });

function wireResponse(response: Response): HttpServerResponse.HttpServerResponse {
  return HttpServerResponse.raw(response, { status: response.status });
}
