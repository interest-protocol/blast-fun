import { errorLabel, observeMetric } from "@blast/core/lib/metrics.ts";
import { databaseErrorCause } from "@blast/core/modules/database/retry.ts";

/** Bounded, process-local public read reuse. No Redis or authorization state. */
export type ReadCache<T> = Readonly<{ read(key: string, load: () => Promise<T>, age?: (ms: number) => void): Promise<T>; clear(): void }>;

type Entry<T> = { startedMs: number; pending: boolean; value: Promise<T>; next?: Entry<T> };

/**
 * One load per key at a time; concurrent reads of a key share it. With
 * `stale`, an answer past `ttlMs` is still served for up to `stale.ms` more
 * while one background load replaces it, so readers do not wait on a refresh
 * and a failed refresh keeps the last good answer (counted as
 * `read_cache.refresh` under `stale.label`). Past that bound, readers wait for
 * a fresh load again. A failed load is never kept.
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
  const start = (key: string, load: () => Promise<T>): Entry<T> => {
    const entry: Entry<T> = { startedMs: now(), pending: true, value: Promise.resolve().then(load) };
    entry.value = entry.value.then((value) => {
      entry.pending = false;
      return value;
    }, (error: unknown) => {
      if (entries.get(key) === entry) entries.delete(key);
      throw error;
    });
    return entry;
  };
  const refresh = (key: string, held: Entry<T>, load: () => Promise<T>): Entry<T> => {
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
