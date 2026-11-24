/** Test helpers shared across packages and apps. Import by relative path; they run under Node and Bun. */

/** A v4-shaped UUID whose last group is `n` in hex. */
export const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

/** A 32-byte Sui address or object id ending in `tag`. */
export const hex = (tag: string) => `0x${tag.padStart(64, "0")}`;

/** A promise with its resolver exposed. */
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
