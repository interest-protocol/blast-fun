import type { NonMarketReadRoute } from "@blast/core/modules/backend-api/public-read-routes.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { ReadApi, readEndpoints } from "../../data/api/reads/ReadApi.ts";

export type ReadOperation = (route: NonMarketReadRoute) => Promise<Response>;

export class ReadRequest extends Context.Service<
  ReadRequest,
  { run: ReadOperation; onFailure: (cause: unknown) => void }
>()("blast/backend-api/reads/ReadRequest") {}

export const readHandlers = HttpApiBuilder.group(ReadApi, "reads", (handlers) => {
  type Identifier = (typeof readEndpoints)[number]["endpoint"]["identifier"];
  const bindings = Object.fromEntries(
    readEndpoints.map(
      ({ endpoint, route }) =>
        [
          endpoint.identifier,
          {
            handler: () =>
              Effect.gen(function* () {
                const { run, onFailure } = yield* ReadRequest;
                return yield* Effect.tryPromise({
                  try: () => run(route),
                  catch: (cause) => ({ cause }),
                }).pipe(
                  Effect.match({
                    onSuccess: (response) =>
                      HttpServerResponse.raw(response, { status: response.status }),
                    onFailure: ({ cause }) => {
                      onFailure(cause);
                      return HttpServerResponse.empty({ status: 500 });
                    },
                  }),
                );
              }),
            // Owners observe the request signal. Their permits last until the work settles.
            options: { uninterruptible: true },
          },
        ] as const,
    ),
  ) as Record<
    Identifier,
    {
      handler: () => Effect.Effect<HttpServerResponse.HttpServerResponse, never, ReadRequest>;
      options: { uninterruptible: true };
    }
  >;
  return handlers.handleAll(bindings);
});
