import { z } from "zod";
import { createHash } from "node:crypto";
import { createClient, ErrorReply } from "@redis/client";
import { waitUntil } from "@vercel/functions";

import { isLoopbackHostname } from "./loopback.ts";
import { recordMetric, timed } from "./metrics.ts";
import { processSingleton } from "./process-singleton.ts";

export interface RedisCommands {
  execute(arguments_: string[]): Promise<unknown>;
  /** Changes before opening a replacement connection; consumers must reconcile state. */
  connectionEpoch?(): number;
  /** Refuses before sending if this connection is no longer the reconciled epoch. */
  executeAtEpoch?(arguments_: string[], epoch: number): Promise<unknown>;
}

export function configuredRedis(purpose: "cache" | "quota" | "private-replay") {
  const url =
    process.env[
      purpose === "cache" ? "BLAST_CACHE_REDIS_URL" : "BLAST_QUOTA_REDIS_URL"
    ];
  if (!url) return null;
  const quotaUrl = process.env.BLAST_QUOTA_REDIS_URL;
  if (purpose === "cache" && quotaUrl && sameHostedStore(url, quotaUrl)) {
    recordMetric("redis.connection", {
      purpose,
      outcome: "shared_store_refused",
    });
    return null;
  }
  return processSingleton(`redis.${purpose}`, () =>
    createRedisConnection(url, purpose),
  );
}

function sameHostedStore(cacheUrl: string, quotaUrl: string): boolean {
  const cache = URL.parse(cacheUrl);
  const quota = URL.parse(quotaUrl);
  if (
    !cache ||
    !quota ||
    isLoopbackHostname(cache.hostname) ||
    cache.hostname !== quota.hostname ||
    (cache.port || "6379") !== (quota.port || "6379")
  )
    return false;
  // Render's regional external proxy routes by the red-… service username.
  // Generic Redis ACL usernames do not identify separate stores.
  if (
    /^[a-z]+-keyvalue\.render\.com$/.test(cache.hostname) &&
    [cache, quota].every(
      (url) =>
        url.protocol === "rediss:" && /^red-[a-z0-9]{20}$/.test(url.username),
    )
  ) {
    return cache.username === quota.username;
  }
  return true;
}

/** One bounded connection per process and purpose. Never queue writes across reconnects. */
export function createRedisConnection(
  connectionUrl: string,
  purpose: "cache" | "quota" | "private-replay",
) {
  if (typeof window !== "undefined") throw new Error("Redis is server-only.");
  validateRedisUrl(connectionUrl);
  let client: ReturnType<typeof createClient> | undefined;
  let connecting: Promise<void> | undefined;
  let warming: Promise<void> | undefined;
  let retryAt = 0;
  let pending = 0;
  let connectionEpoch = 0;

  async function connected(expectedEpoch?: number) {
    if (
      expectedEpoch !== undefined &&
      (expectedEpoch !== connectionEpoch || !client?.isReady || connecting)
    ) {
      throw new RedisEpochChanged();
    }
    if (client?.isReady && !connecting) return client;
    if (Date.now() < retryAt) throw new RedisBackoff();
    if (!connecting) {
      connectionEpoch++;
      client = createClient({
        url: connectionUrl,
        socket: { connectTimeout: 2_500, reconnectStrategy: false },
        disableOfflineQueue: true,
        commandsQueueMaxLength: 128,
      });
      // Redis errors can contain hostnames or credentials. Record a fixed label only.
      client.on("error", () =>
        recordMetric("redis.connection", { purpose, outcome: "error" }),
      );
      const opening = client;
      connecting = boundedRedisOperation(
        opening,
        () => opening.connect(),
        2_500,
      )
        .then(async () => {
          if (purpose !== "cache") {
            await verifyQuotaStorage(
              {
                execute: (args) =>
                  boundedRedisOperation(
                    opening,
                    () => opening.sendCommand(args),
                    500,
                  ),
              },
              new URL(connectionUrl).protocol === "rediss:",
            );
          }
        })
        .catch(() => {
          recordMetric("redis.connection", {
            purpose,
            outcome: "connect_failed",
          });
          if (opening.isOpen) opening.destroy();
          retryAt = Date.now() + 1_000;
          throw new Error("Redis connection failed.");
        })
        .finally(() => {
          connecting = undefined;
        });
    }
    await connecting;
    if (!client?.isReady) throw new Error("Redis connection is unavailable.");
    return client;
  }

  // Requests retain the same cold-start promise; ready connections need no PING.
  function warm(): Promise<void> | undefined {
    if ((client?.isReady && !connecting) || Date.now() < retryAt) return;
    warming ??= connected()
      .then(() => {})
      .catch(() => {})
      .finally(() => {
        warming = undefined;
      });
    return warming;
  }

  function refuseCommand(
    error: unknown,
    ready?: ReturnType<typeof createClient>,
  ): never {
    const failure = redisCommandFailure(error);
    // Only bounded indices and fixed labels: never Redis messages or subject keys.
    recordMetric("redis.command", { purpose, ...failure });
    if (error instanceof ErrorReply && failure.outcome !== "replica_or_down") {
      if (failure.outcome === "script_missing") throw new RedisScriptMissing();
      throw new Error("Redis command refused.");
    }
    // A dead socket must not accumulate timed-out reply waiters indefinitely.
    if (ready) {
      if (ready.isOpen) ready.destroy();
      retryAt = Date.now() + 1_000;
    }
    throw new Error("Redis operation unavailable.");
  }

  async function execute(
    arguments_: string[],
    expectedEpoch?: number,
  ): Promise<unknown> {
    if (pending >= 128) {
      recordMetric("redis.command", { purpose, outcome: "busy" });
      throw new RedisBusy();
    }
    // Optional caching must never put connection establishment on a read's path.
    // Warm the shared connection in the background; this request uses its source.
    if (purpose === "cache" && (!client?.isReady || connecting)) {
      const backingOff = Date.now() < retryAt;
      const background = warm();
      if (background) waitUntil(background);
      if (Math.random() < 0.02) {
        recordMetric("redis.command", {
          purpose,
          outcome: backingOff ? "backoff" : "warming",
          sampleRate: 0.02,
        });
      }
      throw new RedisNotReady();
    }
    pending++;
    let ready: Awaited<ReturnType<typeof connected>> | undefined;
    try {
      return await timed(
        "redis.command.latency",
        async () => {
          ready = await connected(expectedEpoch);
          if (expectedEpoch !== undefined && expectedEpoch !== connectionEpoch)
            throw new RedisEpochChanged();
          // A timed-out quota command might already have executed. Never retry it.
          const active = ready;
          return boundedRedisOperation(
            active,
            () => active.sendCommand(arguments_),
            500,
          );
        },
        { purpose },
        { sampleRate: 0.02 },
      );
    } catch (error) {
      if (error instanceof RedisEpochChanged) throw error;
      return refuseCommand(error, ready);
    } finally {
      pending--;
    }
  }

  return {
    warm,
    connectionEpoch: () => connectionEpoch,
    execute,
    executeAtEpoch: (arguments_: string[], epoch: number) =>
      execute(arguments_, epoch),
    close() {
      if (client?.isOpen) client.destroy();
    },
  };
}

/** node-redis's command abort covers unsent commands; an in-flight deadline must close the socket. */
function boundedRedisOperation<T>(
  client: ReturnType<typeof createClient>,
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      if (client.isOpen) client.destroy();
      reject(new Error("Redis deadline exceeded."));
    }, timeoutMs);
  });
  return Promise.race([Promise.resolve().then(operation), deadline]).finally(
    () => clearTimeout(timer),
  );
}

function validateRedisUrl(value: string): void {
  try {
    const url = new URL(value);
    const loopback = isLoopbackHostname(url.hostname);
    if (
      url.search ||
      url.hash ||
      !["", "/", "/0"].includes(url.pathname) ||
      (url.protocol !== "rediss:" &&
        !(url.protocol === "redis:" && loopback)) ||
      (!loopback && !url.password)
    )
      throw new Error();
  } catch {
    throw new Error(
      "Redis requires an authenticated TLS URL (plaintext loopback is allowed for tests).",
    );
  }
}

/** Explicit environment identity prevents preview counters/data from sharing production keys. */
export function redisNamespace(value: string | undefined): string {
  if (!z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/).safeParse(value).success) {
    throw new Error(
      "BLAST_REDIS_NAMESPACE must identify the network, deployment and environment.",
    );
  }
  return value as string;
}

export class RedisBusy extends Error {
  override name = "RedisBusy";
}
export class RedisEpochChanged extends Error {
  override name = "RedisEpochChanged";
}
export class RedisNotReady extends Error {
  override name = "RedisNotReady";
}
class RedisBackoff extends Error {
  override name = "RedisBackoff";
}
class RedisScriptMissing extends Error {
  override name = "RedisScriptMissing";
}

function redisCommandFailure(error: unknown): {
  outcome: string;
  window?: number;
} {
  if (error instanceof RedisBackoff) return { outcome: "backoff" };
  if (!(error instanceof ErrorReply)) return { outcome: "unavailable" };
  if (/^NOSCRIPT\b/.test(error.message)) return { outcome: "script_missing" };
  if (/^(READONLY|MASTERDOWN)\b/.test(error.message))
    return { outcome: "replica_or_down" };
  const corrupted = /^(?:ERR )?CORRUPT ([1-9]\d{0,2})$/.exec(error.message);
  const window = corrupted ? Number(corrupted[1]) : 0;
  if (window > 0 && window <= 128)
    return { outcome: "counter_corrupt", window };
  return { outcome: "reply_error" };
}

/** Retry only NOSCRIPT: Redis guarantees the absent script did not execute. */
export function redisScript(source: string) {
  const sha = createHash("sha1").update(source).digest("hex");
  return async (redis: RedisCommands, keys: string[], arguments_: string[]) => {
    try {
      return await redis.execute([
        "EVALSHA",
        sha,
        String(keys.length),
        ...keys,
        ...arguments_,
      ]);
    } catch (error) {
      if (!(error instanceof RedisScriptMissing)) throw error;
      return redis.execute([
        "EVAL",
        source,
        String(keys.length),
        ...keys,
        ...arguments_,
      ]);
    }
  };
}

/** Managed Render forbids CONFIG GET; INFO reports effective safety settings. */
export async function verifyQuotaStorage(
  redis: RedisCommands,
  hosted: boolean,
): Promise<void> {
  const memory = await redis.execute(["INFO", "memory"]);
  if (
    !z.string().regex(/^maxmemory_policy:noeviction\r?$/m).safeParse(memory).success
  ) {
    throw new Error("Quota storage must not evict counters.");
  }
  if (hosted) {
    const persistence = await redis.execute(["INFO", "persistence"]);
    if (!z.string().regex(/^aof_enabled:1\r?$/m).safeParse(persistence).success) {
      throw new Error("Hosted quota storage requires journaling.");
    }
  }
}
