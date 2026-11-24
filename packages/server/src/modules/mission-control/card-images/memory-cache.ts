import { z } from "zod";
import { LRUCache } from "lru-cache";

/** PNG bytes bounded by total byte length; a zero budget disables storage. */
export class ByteLruCache {
  readonly #cache: LRUCache<string, Buffer> | undefined;

  constructor(maxBytes: number) {
    if (!z.number().int().nonnegative().safeParse(maxBytes).success) {
      throw new RangeError("The card image memory cache size must be a non-negative integer.");
    }
    this.#cache = maxBytes === 0 ? undefined : new LRUCache<string, Buffer>({
      maxSize: maxBytes,
      sizeCalculation: (bytes) => bytes.byteLength,
    });
  }

  get size(): number {
    return this.#cache?.size ?? 0;
  }

  get bytes(): number {
    return this.#cache?.calculatedSize ?? 0;
  }

  get(key: string): Buffer | undefined {
    return this.#cache?.get(key);
  }

  set(key: string, bytes: Buffer): void {
    // Empty PNGs cannot consume an unlimited number of zero-weight keys.
    this.#cache?.set(key, bytes.byteLength ? bytes : undefined);
  }
}
