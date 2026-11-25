import type { RedisCommands } from "@blast/core/lib/redis.ts";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { committedDisplayPrices } from "@blast/server/modules/launchpad-market/display-price-feed.ts";
import { MarketStreamRelay } from "@blast/server/modules/launchpad-market/stream-relay.ts";
import { openActivitySocket } from "@blast/server/modules/social/activity/hint-runtime.ts";
import { createLiveSocket } from "../../transport/live-socket.ts";
import { createBackendHttp } from "../server.ts";
import { serveBackend, type BackendServerOptions } from "../../transport/server.ts";
import type { hintsConfig } from "./config.ts";

export const HINTS_READINESS_DEPENDENCIES = Object.freeze(["quota-redis", "private-replay-redis"]);

type OwnedRedis = RedisCommands & Readonly<{ close(): void }>;

/** Serve the direct live market socket and readiness; every HTTP route is refused. */
export function createHintsServer(
  config: ReturnType<typeof hintsConfig> & Readonly<{ streamDrainMs?: number }>,
  redis: OwnedRedis,
  privateReplayRedis: OwnedRedis,
) {
  const expected = config.marketEnabled ? config.marketExpected : null;
  const options: BackendServerOptions = {
    ...config,
    redis,
    privateReplayRedis,
    handle: async () =>
      Response.json(
        { error: { code: "private_gateway_forbidden" } },
        { status: 403, headers: { "Cache-Control": "private, no-store" } },
      ),
    async ready() {
      // This probe says nothing about SQL or the reader's live hint handshake.
      await Promise.all([redis.execute(["PING"]), privateReplayRedis.execute(["PING"])]);
      return true;
    },
  };
  // The direct browser socket exists only on a configured live host.
  const live =
    expected !== null && config.liveHost
      ? createLiveSocket({
          host: config.liveHost,
          siteOrigin: config.siteOrigin,
          gatewaySecret: config.gatewaySecret,
          namespace: config.namespace,
          redis: privateReplayRedis,
          ingress: config.ingress,
          relay: processSingleton(
            "launchpad.market-stream",
            () =>
              new MarketStreamRelay(
                openActivitySocket,
                expected,
                committedDisplayPrices(expected),
                config.maxHintStreams,
              ),
          ),
          drainMs: config.streamDrainMs,
        })
      : undefined;
  const runtime = serveBackend(options, createBackendHttp(options), live);
  let stopped: Promise<void> | undefined;
  return {
    server: runtime.server,
    readinessDependencies: HINTS_READINESS_DEPENDENCIES,
    drain() {
      stopped ??= runtime.drain().finally(() => {
        redis.close();
        privateReplayRedis.close();
      });
      return stopped;
    },
  };
}
