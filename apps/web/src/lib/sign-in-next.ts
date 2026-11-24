/** Where sign-in returns when `next` is missing or refused. */
export const SIGN_IN_DEFAULT_NEXT = "/";

const ORIGIN = "https://sign-in.invalid";

/** Path prefixes sign-in may return to: the presale's areas and social profiles (`/@<callsign>`, OA-4, and `/crew/<callsign>`). */
const NEXT_PREFIXES = ["/presale/", "/settings/", "/crew/", "/@"];

/** Paths sign-in may return to exactly: the home feed, the presale's area roots and Create (UI-20). */
const NEXT_EXACT = [
  "/",
  "/presale",
  "/settings",
  "/create",
  "/launch",
  "/bonding",
];

function isAllowedPathname(pathname: string): boolean {
  return (
    NEXT_EXACT.includes(pathname) ||
    NEXT_PREFIXES.some(
      (prefix) =>
        pathname.startsWith(prefix) && pathname.length > prefix.length,
    )
  );
}

/**
 * The same-origin path sign-in returns to for a `next` search parameter, or
 * `null` when it is refused. `raw` is the already-decoded parameter value.
 *
 * Accepted: `/` exactly, `/presale` and `/settings` and paths under them, and
 * paths under `/crew/` and `/@`, each with an optional query string (a fragment is
 * dropped). Refused: everything else, including absolute and protocol-relative
 * URLs, backslashes, whitespace or control characters, dot segments, and
 * encoded slashes, backslashes, dots or percent signs (a second decoding layer).
 */
export function allowedSignInNext(
  raw: string | string[] | null | undefined,
): string | null {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//"))
    return null;
  if (/[\\\s\p{Cc}]/u.test(raw) || /%(2f|5c|2e|25)/i.test(raw)) return null;
  const end = raw.search(/[?#]/);
  const path = end === -1 ? raw : raw.slice(0, end);
  if (path.split("/").some((segment) => segment === "." || segment === ".."))
    return null;
  let url: URL;
  try {
    url = new URL(raw, ORIGIN);
  } catch {
    return null;
  }
  // The URL parser must not have moved the path (normalisation or another origin).
  if (url.origin !== ORIGIN || url.pathname !== path) return null;
  return isAllowedPathname(url.pathname) ? url.pathname + url.search : null;
}

/** `allowedSignInNext`, falling back to `SIGN_IN_DEFAULT_NEXT` when refused. */
export function signInReturnPath(
  raw: string | string[] | null | undefined,
): string {
  return allowedSignInNext(raw) ?? SIGN_IN_DEFAULT_NEXT;
}
