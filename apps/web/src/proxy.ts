import { referralCallsign, REFERRAL_COOKIE, REFERRAL_MAX_AGE } from "@blast/core/modules/social/referrals/contracts.ts";
import { NextResponse, userAgent, type NextRequest } from "next/server";
import { publicErrorResponse } from "@blast/core/lib/http-errors.ts";
import { presaleConfigFor, presaleConnectSources } from "#web/components/presale/config.ts";
import { isBlastExperienceEnabled } from "#web/lib/experience.ts";
import { launchFlagsFor, type LaunchFlags } from "@blast/core/lib/launch-flags.ts";
import {
  decideMissionControlRoute,
  HOME_REWRITE_HEADER,
  MISSION_CONTROL_ENTRY,
  notFoundAnswersJson,
  PRESALE_ENTRY,
  SOCIAL_ENTRY,
  socialProfileTarget,
} from "@blast/core/lib/mission-control/route-policy.ts";
import {
  apiGateVerdict,
  gateRefusalResponse,
  gateUnavailableResponse,
  pageGateCookie,
} from "#web/lib/web-security/api-gate.ts";
import { securityHeaders } from "#web/lib/web-security/browser-policy.ts";
import { webConfig } from "#web/lib/server-config.ts";
import { isPartnerRequest, partnerResponseHeaders, PARTNER_KEY_HEADER } from "@blast/core/modules/backend-api/partner-http.ts";
import { anonymousPartnerHeaders } from "@blast/server/modules/partner-api/v1/response.ts";
import { applyPartnerBrowserHeaders } from "#web/lib/web-security/partner-response.ts";
import { partnerV1Route, isRegionalPartnerRead } from "@blast/server/modules/partner-api/v1/paths.ts";

/**
 * `nonce: null` for the prerendered pages (`PRERENDERED_PAGES`), which the CDN
 * serves without one. The presale flag controls the allowed connection sources.
 */
function browserSecurityHeaders(nonce: string | null, presaleEnabled: boolean): Readonly<Record<string, string>> {
  return securityHeaders({
    nonce,
    development: webConfig().development,
    // Every page carries them, so a client-side navigation into the presale keeps working.
    presaleConnectSources: presaleConnectSources(presaleConfigFor(webConfig().presale, presaleEnabled)),
  });
}

/**
 * A gated route's 404: the presale's published `not_found` body on its and the
 * launchpad's API namespaces, an empty body on pages. The message is the
 * presale route kit's fixed text, so one code carries one message whichever
 * layer answers (proxy.test.ts compares them); the route kit itself is not
 * imported here, because it loads database modules.
 */
function notFound(pathname: string): NextResponse {
  const headers = { "Cache-Control": "no-store" };
  if (!notFoundAnswersJson(pathname)) return new NextResponse(null, { status: 404, headers });
  const response = publicErrorResponse("not_found", "Not found.", 404, { route: "proxy.api.not_found" });
  return new NextResponse(response.body, { status: response.status, headers: response.headers });
}

/**
 * Marks the request a `/@<callsign>` rewrite forwards to the profile page.
 * At worst a client that sends it itself sees the profile under
 * `/crew/<callsign>` instead of being redirected.
 */
const PROFILE_REWRITE_HEADER = "x-blast-profile-rewrite";
const PNL_CARD_PAGE = /^\/card\/pnl\/[^/]+$/;

// Prerendered at build and served from the CDN cache, so their HTML cannot
// carry a per-request nonce: they get the same CSP with 'unsafe-inline'
// instead (`createContentSecurityPolicy`). Only pages built entirely from
// source content belong here; every other page keeps the nonce.
const PRERENDERED_PAGES = new Set(["/privacy", "/terms"]);

function applyBrowserSecurity(response: NextResponse, nonce: string | null, flags: LaunchFlags): NextResponse {
  for (const [name, value] of Object.entries(browserSecurityHeaders(nonce, flags.presale))) {
    response.headers.set(name, value);
  }
  return response;
}

/**
 * After explicit partner requests authenticate and count in their own read
 * boundary, the first-party API gate (docs/security/bot-protection.md) runs:
 * an `/api/*` request without a valid gate cookie, and not on the
 * gate's allowlist, is refused here (401 `gate_required`), so neither a route,
 * a rate-limit write nor the CDN cache sees it. Every page response the proxy
 * answers carries a fresh gate cookie when the request's is missing or
 * older than 30 minutes.
 */
export function proxy(request: NextRequest) {
  // The dynamic regional route admits these reads before accessing data.
  // Forward the actual credential, never a spoofable authorization marker.
  if (isRegionalPartnerRead(request)) {
    const headers = anonymousPartnerHeaders(request);
    const key = request.headers.get(PARTNER_KEY_HEADER);
    if (key !== null) headers.set(PARTNER_KEY_HEADER, key);
    return applyPartnerBrowserHeaders(NextResponse.next({ request: { headers } }), partnerResponseHeaders(null), false);
  }
  // Explicit partner credentials never fall back to a browser cookie, even
  // when invalid. Authenticate and count before a route or CDN can answer.
  if (isPartnerRequest(request)) return partnerRequest(request);
  const flags = launchFlagsFor();
  const gate = apiGateVerdict(request, { gate: webConfig().gate });
  if (gate.kind === "refuse" || gate.kind === "unavailable") {
    const refusal = gate.kind === "refuse" ? gateRefusalResponse() : gateUnavailableResponse();
    return applyBrowserSecurity(
      new NextResponse(refusal.body, { status: refusal.status, headers: refusal.headers }),
      crypto.randomUUID().replaceAll("-", ""),
      flags,
    );
  }
  const response = routeRequest(request, flags);
  const cookie = gate.kind === "page" ? pageGateCookie(request, { gate: webConfig().gate }) : null;
  if (cookie) response.headers.append("Set-Cookie", cookie);
  const referral = referralCallsign(request.nextUrl.searchParams.get("ref"));
  if (request.method === "GET" && !request.nextUrl.pathname.startsWith("/api/") && referral && response.status < 400) {
    response.cookies.set(REFERRAL_COOKIE, referral, { path: "/", maxAge: REFERRAL_MAX_AGE, secure: true, httpOnly: true, sameSite: "lax" });
    response.headers.set("Cache-Control", "private, no-store");
  }
  return response;
}

function partnerRequest(request: NextRequest): NextResponse {
  const registered = partnerV1Route(request.nextUrl.pathname) !== null;
  const headers = partnerResponseHeaders(null);
  if (registered) headers.set("Allow", "GET, HEAD, OPTIONS");
  const refusal = registered
    ? publicErrorResponse("partner_read_only", "Partner access is read-only.", 405, { headers })
    : publicErrorResponse("partner_read_forbidden", "This endpoint is not available to partners.", 403, { headers });
  return applyPartnerBrowserHeaders(new NextResponse(request.method === "HEAD" ? null : refusal.body, { status: refusal.status, headers: refusal.headers }), headers, true);
}

function pnlCardRedirect(request: NextRequest): NextResponse | null {
  if (!PNL_CARD_PAGE.test(request.nextUrl.pathname) || (request.method !== "GET" && request.method !== "HEAD")) {
    return null;
  }
  // Social crawlers need the card page to read its preview metadata.
  if (userAgent(request).isBot) return null;

  const target = request.nextUrl.clone();
  target.pathname = "/";
  return NextResponse.redirect(target, {
    status: 307,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function routeRequest(request: NextRequest, flags: LaunchFlags): NextResponse {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const requestHeaders = new Headers(request.headers);
  // Only this proxy marks a home rewrite.
  requestHeaders.delete(HOME_REWRITE_HEADER);
  const headers = browserSecurityHeaders(nonce, flags.presale);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", headers["Content-Security-Policy"]);

  const decision = decideMissionControlRoute(
    request.nextUrl.pathname,
    isBlastExperienceEnabled(),
    flags.presale,
    flags.launchpad,
    flags.social,
  );
  if (decision === "not-found") {
    return applyBrowserSecurity(notFound(request.nextUrl.pathname), nonce, flags);
  }
  if (decision === "allow" && PRERENDERED_PAGES.has(request.nextUrl.pathname)) {
    return applyBrowserSecurity(NextResponse.next(), null, flags);
  }
  if (decision === "allow") {
    return applyBrowserSecurity(
      pnlCardRedirect(request) ?? NextResponse.next({ request: { headers: requestHeaders } }),
      nonce,
      flags,
    );
  }
  if (decision === "redirect-mission") {
    return applyBrowserSecurity(
      NextResponse.redirect(new URL(MISSION_CONTROL_ENTRY, request.url)),
      nonce,
      flags,
    );
  }
  if (decision === "redirect-profile" && request.headers.get(PROFILE_REWRITE_HEADER) === "1") {
    // The page request behind a `/@<callsign>` rewrite reaches the proxy
    // again under the page's own path: serve it, do not redirect it back.
    return applyBrowserSecurity(NextResponse.next({ request: { headers: requestHeaders } }), nonce, flags);
  }
  if (decision === "redirect-profile" || decision === "rewrite-profile") {
    // `/@<callsign>` is the profile's address (OA-4): the proxy serves the
    // profile page under it, and the page's own `/crew/<callsign>` redirects
    // to it, keeping the query. Temporary (307), since it holds only while
    // the social feed is on.
    const target = request.nextUrl.clone();
    target.pathname = socialProfileTarget(request.nextUrl.pathname)!;
    if (decision === "redirect-profile") {
      return applyBrowserSecurity(NextResponse.redirect(target, 307), nonce, flags);
    }
    requestHeaders.set(PROFILE_REWRITE_HEADER, "1");
    return applyBrowserSecurity(
      NextResponse.rewrite(target, { request: { headers: requestHeaders } }),
      nonce,
      flags,
    );
  }
  if (decision === "rewrite-home") {
    // Serve the brand landing at `/` and preserve its referral query.
    const target = request.nextUrl.clone();
    target.pathname = MISSION_CONTROL_ENTRY;
    requestHeaders.set(HOME_REWRITE_HEADER, "1");
    return applyBrowserSecurity(
      NextResponse.rewrite(target, { request: { headers: requestHeaders } }),
      nonce,
      flags,
    );
  }
  if (decision === "rewrite-presale" || decision === "rewrite-social") {
    // A rewrite does not run the proxy again for its target, so the forwarded
    // headers carry this request's nonce and CSP to the presale or feed page.
    // The query string (referral and campaign tags) reaches that page, and
    // the address bar keeps `/`.
    const target = request.nextUrl.clone();
    target.pathname = decision === "rewrite-social" ? SOCIAL_ENTRY : PRESALE_ENTRY;
    return applyBrowserSecurity(
      NextResponse.rewrite(target, { request: { headers: requestHeaders } }),
      nonce,
      flags,
    );
  }
  return applyBrowserSecurity(
    NextResponse.rewrite(new URL(MISSION_CONTROL_ENTRY, request.url), {
      request: { headers: requestHeaders },
    }),
    nonce,
    flags,
  );
}

export const config = {
  // Run the policy on retired Mission URLs and reserved app namespaces even
  // when a path has an extension. Public assets and framework chunks bypass it.
  matcher: [
    "/((?!_next/|.*\\.[a-zA-Z0-9]+$).*)",
    "/api/:path*",
    "/mission-control/:path*",
    "/card/:path*",
    "/coin/:path*",
    "/launch/:path*",
    "/presale/:path*",
    "/sign-in/:path*",
    "/settings/:path*",
  ],
};
