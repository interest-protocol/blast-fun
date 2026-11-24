/** Bounded, process-local public read reuse. No Redis or authorization state. */
export type ReadCache<T> = Readonly<{ read(key: string, load: () => Promise<T>, age?: (ms: number) => void): Promise<T>; clear(): void }>;

export function createReadCache<T>(ttlMs: number, maxEntries: number, now = Date.now): ReadCache<T> {
  const entries = new Map<string, { until: number; pending: boolean; value: Promise<T> }>();
  return {
    read(key, load, age) {
      const held = entries.get(key);
      if (held && (held.pending || held.until > now())) return held.value.then((value) => { age?.(Math.max(0, now() - held.until + ttlMs)); return value; });
      const entry = { until: now() + ttlMs, pending: true, value: Promise.resolve().then(load) };
      entries.delete(key);
      entries.set(key, entry);
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
      entry.value = entry.value.then((value) => {
        entry.pending = false;
        return value;
      }, (error: unknown) => {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      });
      return entry.value.then((value) => { age?.(Math.max(0, now() - entry.until + ttlMs)); return value; });
    },
    clear: () => entries.clear(),
  };
}
