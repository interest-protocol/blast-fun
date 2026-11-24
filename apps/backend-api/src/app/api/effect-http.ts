import {
  createMarketRelay,
  type MarketRoutesDependencies,
} from "@blast/server/modules/launchpad-market/routes.ts";
import { PARTNER_COIN_SEGMENT_LIMIT } from "@blast/server/modules/partner-api/v1/paths.ts";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { Api } from "../../data/api/Api.ts";
import { marketDecodeErrors, MarketRelay, marketHandlers } from "../../features/market/handlers.ts";
import { EXACT_ROUTER_CONFIG } from "./routing-request.ts";

export function createEffectHttp(
  dependencies: Pick<MarketRoutesDependencies, "upstream" | "timeoutMs">,
) {
  const routes = HttpApiBuilder.layer(Api).pipe(
    Layer.provide(marketHandlers),
    Layer.provide(marketDecodeErrors),
    Layer.provide(Layer.succeed(MarketRelay, createMarketRelay(dependencies))),
    Layer.provide(HttpServer.layerServices),
  );
  return HttpRouter.toWebHandler(routes, {
    disableLogger: true,
    routerConfig: { ...EXACT_ROUTER_CONFIG, maxParamLength: PARTNER_COIN_SEGMENT_LIMIT },
  });
}
