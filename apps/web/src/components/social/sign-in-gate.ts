import { SOCIAL_PAGE_PATHS } from "@blast/core/lib/social-page-routes.ts";
import { canonicalHomePath } from "#web/components/blast-ui/nav.ts";
export const SIGN_IN_PATH = SOCIAL_PAGE_PATHS.signIn;

/** The profile page the proxy rewrites `/@<callsign>` to (OA-4). */
const PROFILE_PAGE_PATH = /^\/crew\/([^/]+)$/;

/**
 * Where a visitor's gated tap goes: `/sign-in?next=<path, URL-encoded>`.
 * `path` is the current pathname. Anything that is not a same-origin path
 * (missing, relative, `//host` or `/\host`) falls back to `/`, so the link
 * never names another origin. The proxy's rewrite targets map back to the
 * addresses the browser shows (`/feed` to `/`, `/crew/<callsign>` to
 * `/@<callsign>`), so the server's render and the browser's build the same
 * link.
 */
export function signInHref(path: string | null | undefined): string {
  const safe = path && path.startsWith("/") && !/^\/[/\\]/.test(path) ? path : "/";
  const next = canonicalHomePath(safe).replace(PROFILE_PAGE_PATH, "/@$1");
  return `${SIGN_IN_PATH}?next=${encodeURIComponent(next)}`;
}

/** Public forms stay editable; only their primary action changes with the session. */
export function authenticatedAction(
  session: Readonly<{ signedIn: boolean; sessionPending?: boolean }>,
  label: string,
  signInLabel: string,
  disabled: boolean,
  busy = false,
): Readonly<{ label: string; disabled: boolean }> {
  if (session.sessionPending) return { label: "Restoring session…", disabled: true };
  if (!session.signedIn) return { label: signInLabel, disabled: busy };
  return { label, disabled: busy || disabled };
}
