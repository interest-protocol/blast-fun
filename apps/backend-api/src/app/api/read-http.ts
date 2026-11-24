import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { ReadApi } from "../../data/api/reads/ReadApi.ts";
import { ReadRequest, readHandlers, type ReadOperation } from "../../features/reads/handlers.ts";
import { EXACT_ROUTER_CONFIG, routingRequest } from "./routing-request.ts";

export function createReadHttp() {
  const routes = HttpApiBuilder.layer(ReadApi).pipe(
    Layer.provide(readHandlers),
    Layer.provide(HttpServer.layerServices),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(routes, {
    disableLogger: true,
    routerConfig: EXACT_ROUTER_CONFIG,
  });
  return { handle, dispose };

  async function handle(request: Request, run: ReadOperation) {
    let failure: { cause: unknown } | undefined;
    const response = await handler(
      routingRequest(request),
      Context.make(ReadRequest, {
        run,
        onFailure(cause) {
          failure = { cause };
        },
      }),
    );
    // Preserve the transport's separate first-party and partner error envelopes.
    if (failure) {
      throw failure.cause;
    }
    return response;
  }
}
