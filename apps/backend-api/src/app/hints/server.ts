import type { RedisCommands } from "@blast/core/lib/redis.ts";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { ACTIVITY_HINT_ROUTE_ID } from "@blast/core/modules/backend-api/private/social-stream-contracts.ts";
import { MARKET_STREAM_ROUTE_ID } from "@blast/core/modules/launchpad-contract/market-stream.ts";
import { committedDisplayPrices } from "@blast/server/modules/launchpad-market/display-price-feed.ts";
import { MarketStreamRelay } from "@blast/server/modules/launchpad-market/stream-relay.ts";
import {
  activityHintRelay,
  openActivitySocket,
} from "@blast/server/modules/social/activity/hint-runtime.ts";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { HintsApi } from "../../data/api/hints/HintsApi.ts";
import { HintRelays, VerifiedHintsRequest, hintHandlers } from "../../features/hints/handlers.ts";
import { createBackendServer } from "../server.ts";
import type { hintsConfig } from "./config.ts";

export const HINTS_READINESS_DEPENDENCIES = Object.freeze(["quota-redis", "private-replay-redis"]);

type OwnedRedis = RedisCommands & Readonly<{ close(): void }>;

/** Reuse the private transport's authentication, replay, stream admission and drain. */
export function createHintsServer(
  config: ReturnType<typeof hintsConfig> & Readonly<{ streamDrainMs?: number }>,
  redis: OwnedRedis,
  privateReplayRedis: OwnedRedis,
) {
  const expected = config.marketEnabled ? config.marketExpected : null;
  const market =
    expected === null
      ? null
      : () =>
          processSingleton(
            "launchpad.market-stream",
            () =>
              new MarketStreamRelay(openActivitySocket, expected, committedDisplayPrices(expected)),
          );
  const http = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(HintsApi).pipe(
      Layer.provide(hintHandlers),
      Layer.provide(Layer.succeed(HintRelays, { activity: activityHintRelay, market })),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );
  const runtime = createBackendServer({
    ...config,
    redis,
    privateReplayRedis,
    handle: async () =>
      Response.json(
        { error: { code: "private_gateway_forbidden" } },
        { status: 403, headers: { "Cache-Control": "private, no-store" } },
      ),
    privateApi: {
      siteOrigin: config.siteOrigin,
      allowedRoutes: [
        ACTIVITY_HINT_ROUTE_ID,
        ...(expected === null ? [] : [MARKET_STREAM_ROUTE_ID]),
      ],
      handle: (request, context) =>
        http.handler(request, Context.make(VerifiedHintsRequest, context)),
    },
    async ready() {
      // This probe says nothing about SQL or the reader's live hint handshake.
      await Promise.all([redis.execute(["PING"]), privateReplayRedis.execute(["PING"])]);
      return true;
    },
  });
  let stopped: Promise<void> | undefined;
  return {
    server: runtime.server,
    readinessDependencies: HINTS_READINESS_DEPENDENCIES,
    drain() {
      stopped ??= runtime
        .drain()
        .finally(http.dispose)
        .finally(() => {
          redis.close();
          privateReplayRedis.close();
        });
      return stopped;
    },
  };
}
