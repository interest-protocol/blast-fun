import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { HealthApi, LIVENESS_PATH, READINESS_PATH } from "../data/api/health/HealthApi.ts";
import { livenessHandlers, readinessHandlers } from "../features/health/handlers.ts";

export function createHealthHttp(ready: () => Promise<boolean>) {
  const routes = HttpApiBuilder.layer(HealthApi).pipe(
    Layer.provide(livenessHandlers),
    Layer.provide(readinessHandlers(ready)),
    Layer.provide(HttpServer.layerServices),
  );
  return {
    livenessPath: LIVENESS_PATH,
    readinessPath: READINESS_PATH,
    ...HttpRouter.toWebHandler(routes, { disableLogger: true }),
  };
}
