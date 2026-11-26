import { publicErrorResponse } from "@blast/core/lib/http-errors.ts";
import { requestGateIssuedAt, issueGateCookie } from "@blast/core/lib/web-security/gate-cookie.ts";
import { CRON_ROUTES } from "@blast/core/modules/backend-api/cron-routes.ts";
import { routePattern } from "@blast/core/modules/backend-api/route-path.ts";

import {
  GATE_REFRESH_AFTER_SECONDS,
  GATE_REFRESH_PATH,
  GATE_REFUSAL_HEADER,
  GATE_REFUSAL_VALUE,
  GATE_REQUIRED_ERROR,
} from "@blast/core/lib/web-security/api-gate-protocol.ts";
import { bearerMatches } from "@blast/server/lib/bearer.ts";
import { isPresaleApiKey } from "@blast/server/modules/presale/api-keys/keys.ts";

import type { GateConfig } from "../web-config.ts";

/**
 * The first-party API gate (docs/security/bot-protection.md). Every `/api/*`
 * first-party request must carry a gate cookie the proxy issued on a page
 * load, or match one of `API_GATE_EXEMPTIONS`; anything else is refused before
 * a route, a rate-limit write or the CDN cache sees it.
 * Explicit partner-key requests use the proxy's separate authenticated,
 * rate-limited public-read boundary (`partner-api.ts`) before this gate.
 *
 * The cookie is `v1.<issued-at seconds>.<random id>.<HMAC-SHA256>` under
 * `BLAST_GATE_SECRET` (server-only, at least 32 characters). It identifies
 * nobody and authorizes nothing: it only proves the client loaded a page of
 * this site within the last two hours. `BLAST_GATE_SECRET_PREVIOUS` is also
 * accepted (never issued), so a rotation does not refuse open tabs.
 * Verification is one HMAC per configured secret and a constant-time compare:
 * no database, no network.
 *
 * Without a secret, hosted builds refuse every gated request (503
 * `gate_unavailable`); development and tests use a random per-process secret.
 * The proxy passes `webConfig().gate`.
 */

export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/** A path segment an exemption accepts: no dots, percent escapes or separators. */
const SEGMENT = "[A-Za-z0-9_-]{1,128}";
const READ = ["GET", "HEAD"] as const;

export type ApiGateExemption = Readonly<{
  name: string;
  methods: readonly string[];
  path: RegExp;
  /** A further condition on the request, checked without I/O. */
  when?: (request: Request, gate: GateConfig) => boolean;
  why: string;
}>;

function sameOriginFetch(request: Request): boolean {
  return request.headers.get("sec-fetch-site") === "same-origin";
}

function agentKey(request: Request): boolean {
  const key = request.headers.get("x-blast-api-key");
  return key !== null && isPresaleApiKey(key);
}

/**
 * The only `/api/*` requests served without a gate cookie. Each is matched on
 * method and exact path; the `when` conditions are header checks only.
 */
export const API_GATE_EXEMPTIONS: readonly ApiGateExemption[] = Object.freeze<ApiGateExemption[]>([
  {
    name: "vercel-cron",
    methods: ["GET"],
    path: new RegExp(CRON_ROUTES.map((path) => routePattern(path).source).join("|")),
    when: (request, gate) => bearerMatches(request, gate.cronSecret ?? undefined),
    why: "Vercel Cron sends Authorization: Bearer $CRON_SECRET and no cookie.",
  },
  {
    name: "reward-manifest",
    methods: READ,
    path: new RegExp(`^/api/presale/rewards/rounds/${SEGMENT}/manifest$`),
    why: "Public by contract (docs/presale/rewards.md): anyone may verify a round.",
  },
  {
    name: "receipt-image",
    methods: READ,
    path: new RegExp(`^/api/presale/receipts/${SEGMENT}/${SEGMENT}/image$`),
    why: "Share image fetched by X, Telegram and other unfurlers.",
  },
  {
    name: "presale-agent-key",
    methods: ["POST"],
    path: /^\/api\/presale\/allowlists$/,
    when: agentKey,
    why: "AI agents call with X-Blast-Api-Key; the route kit verifies the key.",
  },
  {
    name: "presale-agent-key",
    methods: READ,
    path: new RegExp(`^/api/presale/allowlists/${SEGMENT}(?:/entries)?$`),
    when: agentKey,
    why: "AI agents call with X-Blast-Api-Key; the route kit verifies the key.",
  },
  {
    name: "presale-agent-key",
    methods: ["POST"],
    path: new RegExp(`^/api/presale/allowlists/${SEGMENT}/bind$`),
    when: agentKey,
    why: "AI agents call with X-Blast-Api-Key; the route kit verifies the key.",
  },
  {
    name: "wallet-metadata",
    methods: READ,
    path: /^\/api\/social\/sign-in\/slush-metadata$/,
    why: "Fetched by the Slush wallet (dApp Kit metadata), not by our pages.",
  },
  {
    name: "og-image",
    methods: READ,
    path: /^\/api\/og$/,
    why: "Social card image (a vercel.json rewrite) fetched by unfurlers.",
  },
  {
    name: "gate-refresh",
    methods: ["GET"],
    path: new RegExp(`^${GATE_REFRESH_PATH.replaceAll("/", "\\/")}$`),
    when: sameOriginFetch,
    why: "Re-issues an expired cookie for a long-lived tab; same-origin only and rate limited.",
  },
]);

/** The exemption `request` matches, or null. */
export function apiGateExemption(request: Request, gate: GateConfig): ApiGateExemption | null {
  const pathname = new URL(request.url).pathname;
  for (const exemption of API_GATE_EXEMPTIONS) {
    if (!exemption.methods.includes(request.method) || !exemption.path.test(pathname)) continue;
    if (!exemption.when || exemption.when(request, gate)) return exemption;
  }
  return null;
}

export type ApiGateVerdict =
  /** Not an API request: the gate does not apply (a page may get a cookie). */
  | Readonly<{ kind: "page" }>
  | Readonly<{ kind: "exempt"; exemption: string }>
  | Readonly<{ kind: "pass"; issuedAt: number }>
  | Readonly<{ kind: "refuse" }>
  /** A hosted build without `BLAST_GATE_SECRET`: nothing can be verified. */
  | Readonly<{ kind: "unavailable" }>;

export function apiGateVerdict(
  request: Request,
  options: Readonly<{ gate: GateConfig; now?: number }>,
): ApiGateVerdict {
  if (!isApiPath(new URL(request.url).pathname)) return { kind: "page" };
  const exemption = apiGateExemption(request, options.gate);
  if (exemption) return { kind: "exempt", exemption: exemption.name };
  const { keys } = options.gate;
  if (!keys) return { kind: "unavailable" };
  const issuedAt = requestGateIssuedAt(request, keys, options.now);
  return issuedAt === null ? { kind: "refuse" } : { kind: "pass", issuedAt };
}

/**
 * The `Set-Cookie` a page request should carry: a fresh gate cookie when the
 * request has none, an invalid one, or one older than
 * `GATE_REFRESH_AFTER_SECONDS`; null otherwise. Every page GET or HEAD the
 * proxy sees qualifies: document navigations and the router's RSC
 * navigations and prefetches alike (the proxy cannot tell them apart, since
 * Next strips the RSC headers), so client-side navigation keeps a tab's cookie
 * fresh.
 */
export function pageGateCookie(
  request: Request,
  options: Readonly<{ gate: GateConfig; now?: number }>,
): string | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (isApiPath(new URL(request.url).pathname)) return null;
  const { keys } = options.gate;
  if (!keys) return null;
  const now = options.now ?? Date.now();
  const issuedAt = requestGateIssuedAt(request, keys, now);
  if (issuedAt !== null && Math.floor(now / 1_000) - issuedAt < GATE_REFRESH_AFTER_SECONDS) return null;
  return issueGateCookie(request, keys, now);
}

const GATE_HEADERS = { "Cache-Control": "no-store" } as const;

/** 401 `{"error":"gate_required"}`, `X-Blast-Gate: required`, never stored. */
export function gateRefusalResponse(): Response {
  return publicErrorResponse(GATE_REQUIRED_ERROR, "Reload this page to verify the request.", 401, {
    headers: { ...GATE_HEADERS, [GATE_REFUSAL_HEADER]: GATE_REFUSAL_VALUE },
    body: { error: GATE_REQUIRED_ERROR, code: GATE_REQUIRED_ERROR, message: "Reload this page to verify the request." },
  });
}

/** 503 `{"error":"gate_unavailable"}`: production has no `BLAST_GATE_SECRET`. */
export function gateUnavailableResponse(): Response {
  return publicErrorResponse("gate_unavailable", "Request verification is temporarily unavailable. Please retry.", 503, { headers: { ...GATE_HEADERS, "Retry-After": "30" }, body: { error: "gate_unavailable", code: "gate_unavailable", message: "Request verification is temporarily unavailable. Please retry." } });
}
