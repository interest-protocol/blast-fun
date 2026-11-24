import { xPhotoCandidates } from "@blast/core/lib/x-photo-url.ts";

/**
 * An avatar is shown only from an `https` URL, or from an inline raster
 * image (`data:image/png|jpeg|webp|gif;base64`, which cannot run script; the
 * server never stores one, but fixtures and previews may pass one); anything
 * else shows the generated default.
 */
export function avatarSource(url: string | null): string | null {
  if (!url) return null;
  if (/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(url)) return url;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** The URLs an avatar tries in order: an X photo's candidates (original first), any other picture as stored. */
export function avatarImageSources(url: string): string[] {
  const candidates = xPhotoCandidates(url);
  return candidates.length ? candidates : [url];
}
