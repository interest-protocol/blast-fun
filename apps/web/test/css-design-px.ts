import { readFileSync as readFile, type PathOrFileDescriptor } from "node:fs";

/**
 * Stylesheet pins read in design pixels. Blast UI lengths are rem since the
 * proportional scale (2026-10-27; 16px = 1rem at the 1440px board), so a test
 * that pins a geometry reads `.css` files with each rem written back as px and a
 * touch minimum's `max(44px, 2.75rem)` as `44px`. Every other file reads as is.
 */
export function readFileSync(path: PathOrFileDescriptor): Buffer;
export function readFileSync(path: PathOrFileDescriptor, encoding: BufferEncoding): string;
export function readFileSync(path: PathOrFileDescriptor, encoding?: BufferEncoding): Buffer | string {
  if (encoding === undefined) return readFile(path);
  const text = readFile(path, encoding);
  return String(path).endsWith(".css") ? cssInDesignPx(text) : text;
}

export function cssInDesignPx(css: string): string {
  return css
    .replace(/max\((\d+)px, [\d.]+rem\)/g, "$1px")
    .replace(/(-?\d*\.?\d+)rem\b/g, (_, rem: string) => `${Number((Number(rem) * 16).toFixed(3))}px`);
}
