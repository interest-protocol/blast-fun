import { z } from "zod";
import { createHash, createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";

import { recordMetric } from "./metrics.ts";
import { RedisNotReady, redisScript, type RedisCommands } from "./redis.ts";

const MAX_VALUE_BYTES = 512 * 1_024;
const LOCAL_MAX_BYTES = 4 * 1_024 * 1_024;
const LOCAL_MAX_ENTRIES = 128;
const LOCAL_TTL_MS = 250;
const unlock = redisScript("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0");
const storeScript = redisScript("if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3]) redis.call('DEL', KEYS[1]) return 1");

function recordReadFailure(error: unknown): void {
  if (!(error instanceof RedisNotReady)) recordMetric("public_read.cache", { outcome: "unavailable" });
  else if (Math.random() < 0.02) recordMetric("public_read.cache", { outcome: "warming", sampleRate: 0.02 });
}

function recordHit(tier: "local" | "redis"): void {
  // This is a sampled signal, not an exact request counter. Keep failures intact.
  if (Math.random() < 0.02) recordMetric("public_read.cache", { outcome: "hit", tier, sampleRate: 0.02 });
}

/** Already verified public JSON only; never extends the signed expiry. */
function verifiedPayloads() {
  const entries = new Map<string, { payload: string; expiresAt: number; until: number; bytes: number }>();
  let bytes = 0;
  function remove(key: string) {
    bytes -= entries.get(key)?.bytes ?? 0;
    entries.delete(key);
  }
  return {
    get(key: string): string | null {
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= Date.now() || entry.until <= performance.now()) {
        remove(key);
        return null;
      }
      return entry.payload;
    },
    set(key: string, payload: string, expiresAt: number) {
      // UTF-16 string storage, including keys; entry count bounds object overhead.
      const size = (key.length + payload.length) * 2;
      if (size > LOCAL_MAX_BYTES) return;
      remove(key);
      entries.set(key, { payload, expiresAt, until: performance.now() + LOCAL_TTL_MS, bytes: size });
      bytes += size;
      while (entries.size > LOCAL_MAX_ENTRIES || bytes > LOCAL_MAX_BYTES) remove(entries.keys().next().value!);
    },
  };
}

/**
 * Public JSON only. Authorization, quotas and feature gates run before calling this.
 * `waitMs` bounds how long a miss waits for another process's load of the key
 * before running its own; set it above the source's usual load time.
 */
export function createPublicReadCache(redis: RedisCommands, namespace: string, signingKey: string, options: Readonly<{ waitMs?: number }> = {}) {
  const waitMs = options.waitMs ?? 1_000;
  if (!z.string().min(32).safeParse(signingKey).success) throw new Error("Public cache signing requires at least 32 characters.");
  const macKey = createHmac("sha256", signingKey).update("blast.public-cache").digest();
  const signature = (key: string, payload: string, expiresAt: number) => createHmac("sha256", macKey)
    .update("blast.public-cache.v2\0").update(key).update("\0").update(String(expiresAt)).update("\0").update(payload).digest();
  const pending = new Map<string, Promise<unknown>>();
  const local = verifiedPayloads();

  async function cached<T>(key: string): Promise<{ data: T } | null> {
    const payload = local.get(key);
    if (payload !== null) {
      recordHit("local");
      // Serialized retention excludes earlier consumer mutations. Concurrent
      // coalesced reads still share a result and must treat it as read-only.
      return { data: JSON.parse(payload) as T };
    }
    const value = await redis.execute(["GET", key]);
    const encoded = z.string().refine((value) => Buffer.byteLength(value) <= MAX_VALUE_BYTES).safeParse(value);
    if (!encoded.success) return null;
    try {
      const parsed = z.object({
        version: z.literal(2), payload: z.string(),
        expiresAt: z.number().int().refine((value) => value > Date.now()),
        mac: z.string().regex(/^[0-9a-f]{64}$/),
      }).safeParse(JSON.parse(encoded.data));
      if (!parsed.success) return null;
      const envelope = parsed.data;
      if (!timingSafeEqual(signature(key, envelope.payload, envelope.expiresAt), Buffer.from(envelope.mac, "hex"))) return null;
      const data = JSON.parse(envelope.payload) as T;
      local.set(key, envelope.payload, envelope.expiresAt);
      recordHit("redis");
      return { data };
    } catch {
      return null;
    }
  }

  /** The TTL counts from the source read's start, so no reader gets an answer older than `ttlMs`. */
  async function store(key: string, lock: string, token: string, result: unknown, readAt: number, ttlMs: number): Promise<boolean> {
    try {
      const payload = JSON.stringify(result);
      const expiresAt = readAt + ttlMs;
      const remainingMs = expiresAt - Date.now();
      if (remainingMs <= 0) return false;
      const encoded = JSON.stringify({ version: 2, payload, expiresAt, mac: signature(key, payload, expiresAt).toString("hex") });
      if (Buffer.byteLength(encoded) > MAX_VALUE_BYTES) {
        recordMetric("public_read.cache", { outcome: "too_large" });
        return false;
      }
      const stored = await storeScript(redis, [lock, key], [token, encoded, String(remainingMs)]) === 1;
      if (!stored) recordMetric("public_read.cache", { outcome: "stale_write_refused" });
      return stored;
    } catch {
      // Serialization or cache failure must never replace a successful source result.
      recordMetric("public_read.cache", { outcome: "write_skipped" });
      return false;
    }
  }

  /** Cross-instance miss coalescing never waits indefinitely for a stuck writer. */
  async function waitForWriter<T>(key: string, lock: string, token: string) {
    const until = performance.now() + waitMs;
    let pauseMs = 50;
    while (performance.now() < until) {
      await setTimeout(Math.min(pauseMs, Math.max(0, until - performance.now())));
      pauseMs = Math.min(250, pauseMs * 2);
      const hit = await cached<T>(key);
      if (hit) return { hit, ownsLock: false };
      if (performance.now() >= until) break;
      // Errors/nulls are not retained. A released lease allows a fresh source
      // read without spending the whole wait budget; held leases remain fenced.
      if (await redis.execute(["SET", lock, token, "NX", "PX", "10000"]) === "OK") {
        return { hit: null, ownsLock: true };
      }
    }
    return { hit: null, ownsLock: false };
  }

  async function read<T>(inputKey: string, load: () => Promise<T>, ttlMs: number): Promise<T> {
    if (ttlMs === 0) return load();
    if (!z.number().int().min(1).max(10_000).safeParse(ttlMs).success) {
      throw new TypeError("Public cache TTL must be at most ten seconds.");
    }
    const digest = createHash("sha256").update(inputKey).digest("hex");
    const key = `${namespace}:public:v2:{${digest}}`;
    const lock = `${key}:loading`;
    const token = randomUUID();
    let ownsLock = false;
    try {
      const hit = await cached<T>(key);
      if (hit) {
        return hit.data;
      }
      // Cover the bounded replica query and subsequent 3s infra fetch. Waiters
      // still fall back after `waitMs`, independently of this writer lease.
      ownsLock = await redis.execute(["SET", lock, token, "NX", "PX", "10000"]) === "OK";
      if (!ownsLock) {
        const waited = await waitForWriter<T>(key, lock, token);
        ownsLock = waited.ownsLock;
        if (waited.hit) return waited.hit.data;
      }
    } catch (error) {
      recordReadFailure(error);
    }

    try {
      const readAt = Date.now();
      const result = await load();
      // Null commonly means not found. Never retain errors or negative lookups.
      if (ownsLock && result !== null && result !== undefined) {
        ownsLock = !await store(key, lock, token, result, readAt, ttlMs);
      }
      return result;
    } finally {
      if (ownsLock) {
        try { await unlock(redis, [lock], [token]); } catch { /* TTL releases it. */ }
      }
    }
  }

  return function publicRead<T>(key: string, load: () => Promise<T>, ttlMs: number): Promise<T> {
    const hit = pending.get(key);
    if (hit) return hit as Promise<T>;
    const promise = read(key, load, ttlMs);
    pending.set(key, promise);
    const clear = () => { if (pending.get(key) === promise) pending.delete(key); };
    void promise.then(clear, clear);
    if (pending.size > 500) pending.delete(pending.keys().next().value!);
    return promise;
  };
}
