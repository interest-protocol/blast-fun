import { observeMetric } from "@blast/core/lib/metrics.ts";

/** Coalesce public reads only; failures and completed detail reads are never retained. */
export function createPublicPresaleReader(now = Date.now, reader?: "feed_new" | "happening") {
  const reads = new Map<string, { at: number; read: Promise<unknown> }>();
  return function publicRead<T>(
    key: string,
    load: () => Promise<T>,
    cacheMs: number,
  ): Promise<T> {
    const hit = reads.get(key);
    // An in-flight read remains reusable even when cacheMs is zero.
    if (hit && (hit.at === Infinity || now() - hit.at < cacheMs)) {
      if (reader) observeMetric("social.public_read.share", { reader, outcome: hit.at === Infinity ? "join" : "hit" }, { sampleRate: 0.02 });
      return hit.read as Promise<T>;
    }
    const read = Promise.resolve().then(load);
    reads.set(key, { at: Infinity, read });
    const discard = () => {
      if (reads.get(key)?.read === read) reads.delete(key);
    };
    void read.then(() => {
      if (cacheMs === 0) discard();
      else if (reads.get(key)?.read === read)
        reads.set(key, { at: now(), read });
    }, discard);
    if (reads.size > 500) reads.delete(reads.keys().next().value!);
    if (reader) observeMetric("social.public_read.share", { reader, outcome: "fill" }, { sampleRate: 0.02 });
    return read;
  };
}
