import {
  CSRF_COOKIE_NAME,
  createCsrfToken,
  csrfCookie,
} from "@blast/core/lib/web-security/mutation-guard.ts";

function hasCsrfCookie(request: Request): boolean {
  const header = request.headers.get("cookie") ?? "";
  return header.split(";").some((part) => {
    const index = part.indexOf("=");
    return (
      index > 0 &&
      part.slice(0, index).trim() === CSRF_COOKIE_NAME &&
      /^[A-Za-z0-9_-]{43}$/.test(part.slice(index + 1).trim())
    );
  });
}

/**
 * `GET /api/launchpad/csrf`: the double-submit CSRF cookie every launchpad
 * mutation checks, set when the visitor has none. It needs no database or
 * secret; a cross-site page can trigger it but never read the cookie.
 */
export async function launchpadCsrfResponse(
  request: Request,
): Promise<Response> {
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (!hasCsrfCookie(request))
    headers.set("Set-Cookie", csrfCookie(createCsrfToken()));
  return new Response(null, { status: 204, headers });
}
