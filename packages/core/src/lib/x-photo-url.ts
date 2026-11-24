/**
 * X profile photo URLs. X serves a photo at its stored name plus a size
 * suffix (`_normal` is 48 px) and usually also at the bare name, the original.
 * Neither is promised: some photos exist only as `_400x400`. So callers never
 * guess one URL; they try `xPhotoCandidates` in order. This file is the only
 * place a size suffix is named.
 */
const PHOTO_PATHS = [
  ["https://pbs.twimg.com", "/profile_images/"],
  ["https://abs.twimg.com", "/sticky/default_profile_images/"],
] as const;
const FALLBACK_SIZE = "_400x400";
const SIZE_SUFFIX = /_(?:mini|normal|bigger|\d+x\d+)(?=\.[a-z]+$|$)/i;

/**
 * The original-size URL of an X profile photo, or `null` when `reference` is
 * not one (another host, another path, credentials, not a URL). Any size
 * suffix, query and fragment are dropped.
 */
export function xPhotoOriginalUrl(reference: string): string | null {
  let url: URL;
  try {
    url = new URL(reference);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (!PHOTO_PATHS.some(([origin, path]) => url.origin === origin && url.pathname.startsWith(path))) return null;
  url.pathname = url.pathname.replace(SIZE_SUFFIX, "");
  url.search = "";
  url.hash = "";
  return url.href;
}

/**
 * The URLs to try for an X profile photo, best first: the original, then the
 * `_400x400` size (some photos exist only at that size). `[]` when `reference`
 * is not an X photo. The default avatar from abs.twimg.com answers both.
 */
export function xPhotoCandidates(reference: string): string[] {
  const original = xPhotoOriginalUrl(reference);
  if (!original) return [];
  const url = new URL(original);
  url.pathname = url.pathname.replace(/(?=\.[a-z]+$|$)/i, FALLBACK_SIZE);
  return [original, url.href];
}
