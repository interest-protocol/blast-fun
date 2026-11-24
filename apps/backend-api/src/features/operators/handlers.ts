import type { OperatorRouteId } from "@blast/core/modules/backend-api/operator-routes.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { OperatorApi, operatorEndpoints } from "../../data/api/operators/OperatorApi.ts";

export type OperatorHandlers = Readonly<
  Record<OperatorRouteId, (request: Request) => Promise<Response>>
>;

export class OperatorRequest extends Context.Service<OperatorRequest, Request>()(
  "blast/backend-api/operators/OperatorRequest",
) {}

export const operatorHandlers = (
  operations: OperatorHandlers,
  failed: (cause: unknown) => Response,
) =>
  HttpApiBuilder.group(OperatorApi, "operators", (handlers) => {
    type Identifier = (typeof operatorEndpoints)[number]["endpoint"]["identifier"];
    const bindings = Object.fromEntries(
      operatorEndpoints.map(({ id, endpoint }) => {
        const operation = operations[id];
        return [
          endpoint.identifier,
          {
            handler: () =>
              // The Web adapter is supplied the authenticated, byte-bounded
              // Request. Preserve its signal and exact body for the owner.
              Effect.gen(function* () {
                const request = yield* OperatorRequest;
                const response = yield* Effect.tryPromise({
                  try: () => operation(request),
                  catch: failed,
                }).pipe(Effect.catch(Effect.succeed));
                return HttpServerResponse.raw(response, { status: response.status });
              }),
            options: { uninterruptible: true },
          },
        ] as const;
      }),
    ) as Record<
      Identifier,
      {
        handler: () => Effect.Effect<HttpServerResponse.HttpServerResponse, never, OperatorRequest>;
        options: { uninterruptible: true };
      }
    >;
    return handlers.handleAll(bindings);
  });
