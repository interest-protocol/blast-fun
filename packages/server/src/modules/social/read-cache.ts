import { errorLabel, observeMetric } from "@blast/core/lib/metrics.ts";
import { databaseErrorCause } from "@blast/core/modules/database/retry.ts";

/**
 * A load. It may report when its data was read (`readAt`, epoch ms) if that
 * is earlier than the load's start, as an answer reused from another process
 * is; the entry then ages from that time.
 */
export type ReadLoad<T> = (readAt: (ms: number) => void) => Promise<T>;

/** Bounded, process-local public read reuse. No Redis or authorization state. */
export type ReadCache<T> = Readonly<{ read(key: string, load: ReadLoad<T>, age?: (ms: number) => void): Promise<T>; clear(): void }>;

/** The fleet-wide public read tier (`publicReadCache`): one load of a key per `ttlMs` across every process. */
export type SharedPublicRead = <T>(key: string, load: () => Promise<T>, ttlMs: number) => Promise<T>;

/** How long one process's read is reused by the others: the CDN's `s-maxage=10`. */
export const SHARED_READ_TTL_MS = 10_000;

/**
 * `load` through the fleet-wide tier, so the API's processes share one read
 * of a public answer instead of each running it against the replica. The
 * answer carries the time its read began, and the local entry ages from that
 * time: a reused answer is never sent as fresher than it is.
 */
export function sharedLoad<T>(shared: SharedPublicRead | undefined, key: string, load: () => Promise<T>, now = Date.now): ReadLoad<T> {
  if (!shared) return load;
  return async (readAt) => {
    const stored = await shared(key, async () => {
      const readAtMs = now();
      return { readAtMs, value: await load() };
    }, SHARED_READ_TTL_MS);
    readAt(stored.readAtMs);
    return stored.value;
  };
}

type Entry<T> = { startedMs: number; pending: boolean; value: Promise<T>; next?: Entry<T> };

/**
 * One load per key at a time; concurrent reads of a key share it. With
 * `stale`, an answer past `ttlMs` is still served for up to `stale.ms` more
 * while one background load replaces it, so readers do not wait on a refresh
 * and a failed refresh keeps the last good answer (counted as
 * `read_cache.refresh` under `stale.label`). Past that bound, readers wait for
 * a fresh load again. A failed load is never kept. Ages count from the load's
 * start, or from the earlier read time it reports.
 */
export function createReadCache<T>(ttlMs: number, maxEntries: number, now = Date.now, stale?: Readonly<{ ms: number; label: string }>): ReadCache<T> {
  const staleMs = stale?.ms ?? 0;
  const label = stale?.label ?? "";
  const entries = new Map<string, Entry<T>>();
  const ageOf = (entry: Entry<T>) => Math.max(0, now() - entry.startedMs);
  const serve = (entry: Entry<T>, age?: (ms: number) => void) => entry.value.then((value) => { age?.(ageOf(entry)); return value; });
  const keep = (key: string, entry: Entry<T>) => {
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
  };
  const start = (key: string, load: ReadLoad<T>): Entry<T> => {
    const startedMs = now();
    const entry: Entry<T> = { startedMs, pending: true, value: Promise.resolve().then(() => load((ms) => { entry.startedMs = Math.min(startedMs, ms); })) };
    entry.value = entry.value.then((value) => {
      entry.pending = false;
      return value;
    }, (error: unknown) => {
      if (entries.get(key) === entry) entries.delete(key);
      throw error;
    });
    return entry;
  };
  const refresh = (key: string, held: Entry<T>, load: ReadLoad<T>): Entry<T> => {
    const next = start(key, load);
    next.value.then(() => { if (entries.get(key) === held) keep(key, next); }, (error: unknown) => {
      if (held.next === next) held.next = undefined;
      observeMetric("read_cache.refresh", { cache: label, outcome: "failed", cause: errorLabel(databaseErrorCause(error)) });
    });
    return next;
  };
  return {
    read(key, load, age) {
      const held = entries.get(key);
      if (held && (held.pending || ageOf(held) < ttlMs)) return serve(held, age);
      if (held && ageOf(held) < ttlMs + staleMs) {
        held.next ??= refresh(key, held, load);
        return serve(held, age);
      }
      const entry = held?.next ?? start(key, load);
      keep(key, entry);
      return serve(entry, age);
    },
    clear: () => entries.clear(),
  };
}
