import type { CleanupReport } from "@blast/core/modules/mission-control/maintenance/contracts.ts";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { CronHttpApi } from "../../data/api/cron/CronHttpApi.ts";
import { cronHandlers } from "../../features/cron/handlers.ts";
import { EXACT_ROUTER_CONFIG } from "./routing-request.ts";

export function createCronHttp(cleanup: () => Promise<CleanupReport>) {
  const routes = HttpApiBuilder.layer(CronHttpApi).pipe(
    Layer.provide(cronHandlers(cleanup)),
    Layer.provide(HttpServer.layerServices),
  );
  return HttpRouter.toWebHandler(routes, {
    disableLogger: true,
    routerConfig: EXACT_ROUTER_CONFIG,
  });
}
