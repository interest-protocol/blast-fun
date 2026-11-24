import type { PrivateContext, PrivateHandlers } from "@blast/server/private/handler.ts";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { PrivateApi } from "../../data/api/private/PrivateApi.ts";
import { PrivateRequest, privateHandlers } from "../../features/private/handlers.ts";
import { TRANSPORT_LIMITS } from "../../transport/contracts.ts";
import { EXACT_ROUTER_CONFIG, routingRequest } from "./routing-request.ts";

export function createPrivateHttp(operations: PrivateHandlers) {
  const routes = HttpApiBuilder.layer(PrivateApi).pipe(
    Layer.provide(privateHandlers(operations)),
    Layer.provide(HttpServer.layerServices),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(routes, {
    disableLogger: true,
    routerConfig: { ...EXACT_ROUTER_CONFIG, maxParamLength: TRANSPORT_LIMITS.headerBytes * 3 },
  });
  return {
    handle: (request: Request, context: PrivateContext) =>
      handler(routingRequest(request), Context.make(PrivateRequest, { request, context })),
    dispose,
  };
}
