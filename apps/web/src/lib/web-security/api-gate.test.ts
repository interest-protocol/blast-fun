import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

import {
  GATE_LIFETIME_SECONDS,
  GATE_REFRESH_AFTER_SECONDS,
  isGateRefusal,
} from "@blast/core/lib/web-security/api-gate-protocol.ts";
import { API_GATE_EXEMPTIONS, apiGateVerdict, gateRefusalResponse, pageGateCookie } from "./api-gate.ts";
import { gateKeys, gateSetCookie, gateTokenIssuedAt, mintGateToken, type GateKeys } from "@blast/core/lib/web-security/gate-cookie.ts";
import type { GateConfig } from "../web-config.ts";
import {
  gateCookieHeader,
  withGateCookie,
} from "../../../test/fixtures/lib/web-security/api-gate-fixtures.ts";
import { gateRefreshResponse } from "@blast/server/lib/web-security/gate-refresh.ts";
import { testClient } from "../../../../../packages/core/test/fixtures/lib/web-security/client-address.ts";
import {
  DEFAULT_RATE_POLICIES,
  PRESALE_RATE_BUCKETS,
  SOCIAL_RATE_BUCKETS,
  WEB_ROUTE_RATE_BUCKETS,
  type RateBucket,
  type RateLimitDecision,
  type RateLimitPort,
  type RateLimitSubject,
} from "@blast/core/lib/web-security/rate-limits.ts";
import {
  routeLimitRefusal,
  withRouteLimits,
} from "@blast/core/modules/web-security/route-limits.ts";

/**
 * WP3 (docs/security/bot-protection.md): the first-party API gate, its
 * allowlist, the proxy's refusal and cookie issuance, the `/api/gate`
 * re-issue, and the rate limits added for routes that had none.
 */

// `server-only` is a bundler marker with no Node entry; the proxy's imports reach it.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only")
      return { url: "data:text/javascript,export {}", shortCircuit: true };
    return next(specifier, context);
  },
});

const SECRET = "gate-unit-secret-is-at-least-thirty-two-characters";
const OTHER = "another-gate-secret-at-least-thirty-two-characters";
const ENV = { BLAST_GATE_SECRET: SECRET, NODE_ENV: "production" } as const;
const KEYS: GateKeys = gateKeys(ENV)!;
const GATE: GateConfig = { keys: KEYS, cronSecret: null };
const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const ORIGIN = "https://www.blast.fun";

function api(path: string, init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}${path}`, init);
}

function withCookie(
  request: Request,
  token: string,
  name = "__Host-blast_gate",
): Request {
  const headers = new Headers(request.headers);
  headers.set("cookie", `privy-token=abc; ${name}=${token}`);
  return new Request(request, { headers });
}

test("a gate token verifies under its secret until it expires, and not a second later", () => {
  const token = mintGateToken(KEYS, NOW);
  assert.match(token, /^v1\.\d+\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(gateTokenIssuedAt(token, KEYS, NOW), Math.floor(NOW / 1_000));
  assert.equal(
    gateTokenIssuedAt(token, KEYS, NOW + (GATE_LIFETIME_SECONDS - 1) * 1_000),
    Math.floor(NOW / 1_000),
  );
  assert.equal(
    gateTokenIssuedAt(token, KEYS, NOW + GATE_LIFETIME_SECONDS * 1_000),
    null,
    "two hours is the lifetime",
  );
  assert.equal(
    gateTokenIssuedAt(token, KEYS, NOW - 120_000),
    null,
    "a token from the future (beyond skew) is refused",
  );
  assert.notEqual(
    mintGateToken(KEYS, NOW),
    token,
    "every token has its own random id",
  );
});

test("a tampered, foreign or malformed gate token never verifies", () => {
  const token = mintGateToken(KEYS, NOW);
  const [version, issuedAt, id, signature] = token.split(".") as [
    string,
    string,
    string,
    string,
  ];
  const flip = (value: string) =>
    (value[0] === "A" ? "B" : "A") + value.slice(1);
  for (const forged of [
    `${version}.${Number(issuedAt) + 1}.${id}.${signature}`,
    `${version}.${issuedAt}.${flip(id)}.${signature}`,
    `${version}.${issuedAt}.${id}.${flip(signature)}`,
    `v2.${issuedAt}.${id}.${signature}`,
    `${token}x`,
    "",
    "v1.0.x.y",
  ]) {
    assert.equal(gateTokenIssuedAt(forged, KEYS, NOW), null, forged);
  }
  assert.equal(
    gateTokenIssuedAt(
      mintGateToken(gateKeys({ BLAST_GATE_SECRET: OTHER })!, NOW),
      KEYS,
      NOW,
    ),
    null,
    "another secret's token",
  );
});

test("rotation: the previous secret still verifies (never signs); a short secret is no secret", () => {
  const old = mintGateToken(gateKeys({ BLAST_GATE_SECRET: OTHER })!, NOW);
  const rotated = gateKeys({
    BLAST_GATE_SECRET: SECRET,
    BLAST_GATE_SECRET_PREVIOUS: OTHER,
  })!;
  assert.equal(gateTokenIssuedAt(old, rotated, NOW), Math.floor(NOW / 1_000));
  assert.equal(
    gateTokenIssuedAt(mintGateToken(rotated, NOW), KEYS, NOW),
    Math.floor(NOW / 1_000),
    "new tokens use the current secret",
  );
  assert.equal(
    gateKeys({ BLAST_GATE_SECRET: "short", NODE_ENV: "production" }),
    null,
  );
  assert.equal(gateKeys({ NODE_ENV: "production" }), null);
  const development = gateKeys({ NODE_ENV: "development" });
  assert.ok(development, "outside production a per-process secret is used");
  assert.deepEqual(
    gateKeys({ NODE_ENV: "test" }),
    development,
    "one per process, so the proxy and /api/gate agree",
  );
});

test("the gate cookie is HttpOnly, SameSite=Lax, Path=/, two hours; __Host- and Secure only over HTTPS", () => {
  assert.equal(
    gateSetCookie("v", true),
    "__Host-blast_gate=v; Path=/; Max-Age=7200; HttpOnly; Secure; SameSite=Lax",
  );
  assert.equal(
    gateSetCookie("v", false),
    "blast_gate=v; Path=/; Max-Age=7200; HttpOnly; SameSite=Lax",
  );
});

test("every /api request needs a valid gate cookie; pages are not gated", () => {
  const verdict = (request: Request) =>
    apiGateVerdict(request, { gate: GATE, now: NOW });
  const token = mintGateToken(KEYS, NOW);
  assert.deepEqual(verdict(api("/")), { kind: "page" });
  assert.deepEqual(verdict(api("/coin/0xabc")), { kind: "page" });
  for (const path of [
    "/api",
    "/api/social/feed",
    "/api/launchpad/search?q=x",
    "/api/presale/presales",
    "/api/whatever/new-route",
  ]) {
    assert.deepEqual(
      verdict(api(path)),
      { kind: "refuse" },
      `${path} without a cookie`,
    );
    assert.deepEqual(
      verdict(withCookie(api(path), token)),
      { kind: "pass", issuedAt: Math.floor(NOW / 1_000) },
      `${path} with one`,
    );
  }
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS", "HEAD"]) {
    assert.deepEqual(
      verdict(api("/api/social/follows/account/kai", { method })),
      { kind: "refuse" },
      method,
    );
  }
  assert.deepEqual(
    verdict(withCookie(api("/api/social/feed"), token, "blast_gate")),
    { kind: "refuse" },
    "the plain-HTTP name is not read over HTTPS",
  );
  // Tamper with the signature's last character (one that differs: it was "A" one run in sixteen).
  const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "Q" : "A"}`;
  assert.deepEqual(verdict(withCookie(api("/api/social/feed"), tampered)), {
    kind: "refuse",
  });
  const expired = mintGateToken(KEYS, NOW - GATE_LIFETIME_SECONDS * 1_000);
  assert.deepEqual(verdict(withCookie(api("/api/social/feed"), expired)), {
    kind: "refuse",
  });
  // Over plain HTTP (local dev) the cookie is `blast_gate`.
  const local = new Request("http://localhost:3561/api/social/feed", {
    headers: { cookie: `blast_gate=${token}` },
  });
  assert.deepEqual(verdict(local), {
    kind: "pass",
    issuedAt: Math.floor(NOW / 1_000),
  });
  // Production without a secret cannot verify anything.
  assert.deepEqual(
    apiGateVerdict(api("/api/social/feed"), {
      gate: { ...GATE, keys: null },
    }),
    { kind: "unavailable" },
  );
});

test("the allowlist: cron with its bearer, the manifest, receipt images, agent keys, wallet metadata, /api/og and /api/gate", () => {
  const gate = { ...GATE, cronSecret: "cron-secret-of-at-least-32-chars" };
  const exempt = (request: Request) => {
    const verdict = apiGateVerdict(request, { gate, now: NOW });
    return verdict.kind === "exempt" ? verdict.exemption : verdict.kind;
  };
  const bearer = { authorization: "Bearer cron-secret-of-at-least-32-chars" };
  const cronPath = "/api/mission-control/maintenance/cleanup";
  assert.equal(exempt(api(cronPath, { headers: bearer })), "vercel-cron");
  assert.equal(exempt(api(cronPath)), "refuse", "no bearer");
  assert.equal(
    exempt(api(cronPath, { headers: { authorization: "Bearer wrong-secret-xxxxxxxx" } })),
    "refuse",
  );
  assert.equal(
    exempt(api("/api/mission-control/maintenance/other", { headers: bearer })),
    "refuse",
  );
  assert.equal(
    exempt(api("/api/mission-control/owner", { headers: bearer })),
    "refuse",
    "the bearer opens only the cron paths",
  );

  const round = "7f1c2a7e-0d9c-4a35-9a77-5f2d4a1b9c01";
  assert.equal(
    exempt(api(`/api/presale/rewards/rounds/${round}/manifest`)),
    "reward-manifest",
  );
  assert.equal(
    exempt(
      api(`/api/presale/rewards/rounds/${round}/manifest`, { method: "HEAD" }),
    ),
    "reward-manifest",
  );
  assert.equal(
    exempt(
      api(`/api/presale/rewards/rounds/${round}/manifest`, { method: "POST" }),
    ),
    "refuse",
  );
  assert.equal(
    exempt(api(`/api/presale/rewards/rounds/%2e%2e/manifest`)),
    "refuse",
    "no escapes in an exempt segment",
  );

  const sale = `0x${"ab".repeat(32)}`;
  assert.equal(
    exempt(api(`/api/presale/receipts/${sale}/${sale}/image?format=png`)),
    "receipt-image",
  );
  assert.equal(exempt(api(`/api/presale/receipts/${sale}/image`)), "refuse");

  const key = { "x-blast-api-key": `blast_ak_${"A".repeat(43)}` };
  assert.equal(
    exempt(api("/api/presale/allowlists", { method: "POST", headers: key })),
    "presale-agent-key",
  );
  assert.equal(
    exempt(api("/api/presale/allowlists/abc-123", { headers: key })),
    "presale-agent-key",
  );
  assert.equal(
    exempt(api("/api/presale/allowlists/abc-123/entries", { headers: key })),
    "presale-agent-key",
  );
  assert.equal(
    exempt(
      api("/api/presale/allowlists/abc-123/entries", {
        method: "POST",
        headers: key,
      }),
    ),
    "refuse",
  );
  assert.equal(
    exempt(
      api("/api/presale/allowlists/abc-123/bind", {
        method: "POST",
        headers: key,
      }),
    ),
    "presale-agent-key",
  );
  assert.equal(
    exempt(
      api("/api/presale/allowlists", {
        method: "POST",
        headers: { "x-blast-api-key": "blast_ak_short" },
      }),
    ),
    "refuse",
    "a malformed key is no key",
  );
  assert.equal(
    exempt(api("/api/presale/sponsor", { method: "POST", headers: key })),
    "refuse",
    "a key opens only the agent routes",
  );
  assert.equal(
    exempt(
      api("/api/presale/allowlists/abc-123", {
        method: "DELETE",
        headers: key,
      }),
    ),
    "refuse",
  );

  assert.equal(
    exempt(api("/api/social/sign-in/slush-metadata")),
    "wallet-metadata",
  );
  assert.equal(
    exempt(api("/api/mission-control/slush-wallet-metadata")),
    "wallet-metadata",
  );
  assert.equal(exempt(api("/api/og")), "og-image");
  assert.equal(exempt(api("/api/og/x")), "refuse");

  assert.equal(
    exempt(api("/api/gate", { headers: { "sec-fetch-site": "same-origin" } })),
    "gate-refresh",
  );
  assert.equal(
    exempt(api("/api/gate", { headers: { "sec-fetch-site": "cross-site" } })),
    "refuse",
  );
  assert.equal(
    exempt(api("/api/gate")),
    "refuse",
    "a client that sends no fetch metadata gets no cookie",
  );
  assert.equal(
    exempt(
      api("/api/gate", {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin" },
      }),
    ),
    "refuse",
  );

  assert.deepEqual(
    [...new Set(API_GATE_EXEMPTIONS.map((exemption) => exemption.name))],
    [
      "vercel-cron",
      "reward-manifest",
      "receipt-image",
      "presale-agent-key",
      "wallet-metadata",
      "og-image",
      "gate-refresh",
    ],
    "the allowlist is exactly the documented one",
  );
});

test("the refusal is 401 {error:gate_required}, never stored, marked for the client", async () => {
  const refusal = gateRefusalResponse();
  assert.equal(refusal.status, 401);
  assert.deepEqual(await refusal.clone().json(), {
    error: "gate_required",
    code: "gate_required",
    message: "Reload this page to verify the request.",
  });
  assert.equal(refusal.headers.get("cache-control"), "no-store");
  assert.equal(refusal.headers.get("x-blast-gate"), "required");
  assert.ok(isGateRefusal(refusal));
  assert.ok(
    !isGateRefusal(
      Response.json({ error: { code: "unauthorized" } }, { status: 401 }),
    ),
    "a route's own 401 is not the gate's",
  );
});

test("a page load gets a cookie when it has none or an old one, and not when it is fresh", () => {
  const cookie = (request: Request, now = NOW) =>
    pageGateCookie(request, { gate: GATE, now });
  const issued = cookie(api("/"));
  assert.match(
    issued ?? "",
    /^__Host-blast_gate=v1\.[^;]+; Path=\/; Max-Age=7200; HttpOnly; Secure; SameSite=Lax$/,
  );
  const token = issued!.split(";", 1)[0]!.split("=")[1]!;
  assert.equal(gateTokenIssuedAt(token, KEYS, NOW), Math.floor(NOW / 1_000));
  assert.equal(
    cookie(
      withCookie(api("/feed"), token),
      NOW + (GATE_REFRESH_AFTER_SECONDS - 1) * 1_000,
    ),
    null,
    "fresh: no new cookie",
  );
  assert.ok(
    cookie(
      withCookie(api("/feed"), token),
      NOW + GATE_REFRESH_AFTER_SECONDS * 1_000,
    ),
    "older than 30 minutes: re-issued",
  );
  assert.ok(
    cookie(withCookie(api("/feed"), "forged")),
    "an invalid one is replaced",
  );
  assert.ok(cookie(api("/coin/0xabc", { method: "HEAD" })));
  assert.equal(
    cookie(api("/feed", { method: "POST" })),
    null,
    "only GET and HEAD",
  );
  assert.equal(
    cookie(api("/api/social/feed")),
    null,
    "API responses never carry one",
  );
  assert.equal(
    pageGateCookie(api("/"), { gate: { ...GATE, keys: null } }),
    null,
    "no secret, no cookie",
  );
  assert.match(
    pageGateCookie(new Request("http://localhost:3561/"), {
      gate: GATE,
      now: NOW,
    }) ?? "",
    /^blast_gate=v1\.[^;]+; Path=\/; Max-Age=7200; HttpOnly; SameSite=Lax$/,
  );
});

test("the proxy refuses an ungated API call before routing, and sets the cookie on pages (RSC navigations included)", async () => {
  const { NextRequest } = await import("next/server");
  const { proxy: handleProxy } = await import("#web/proxy.ts");
  const proxy = (request: Parameters<typeof handleProxy>[0]) =>
    handleProxy(request);
  const refused = await proxy(new NextRequest(`${ORIGIN}/api/social/feed`));
  assert.equal(refused.status, 401);
  assert.deepEqual(await refused.json(), {
    error: "gate_required",
    code: "gate_required",
    message: "Reload this page to verify the request.",
  });
  assert.equal(refused.headers.get("cache-control"), "no-store");
  assert.equal(refused.headers.get("x-blast-gate"), "required");
  assert.ok(
    refused.headers.get("content-security-policy"),
    "the refusal keeps the security headers",
  );
  assert.equal(
    refused.headers.get("x-middleware-next"),
    null,
    "nothing behind the proxy runs",
  );

  const gated = await proxy(
    new NextRequest(withGateCookie(new Request(`${ORIGIN}/api/social/feed`))),
  );
  assert.notEqual(gated.status, 401, "a gated call reaches the route policy");
  assert.equal(
    gated.headers.get("set-cookie"),
    null,
    "API responses carry no cookie",
  );

  const exempt = await proxy(new NextRequest(`${ORIGIN}/api/og`));
  assert.notEqual(exempt.status, 401);

  const page = await proxy(
    new NextRequest(`${ORIGIN}/privacy`, {
      headers: { "sec-fetch-dest": "document" },
    }),
  );
  assert.match(
    page.headers.get("set-cookie") ?? "",
    /__Host-blast_gate=v1\..*HttpOnly; Secure; SameSite=Lax/,
  );
  // The router's RSC fetches (navigations and prefetches) reach the proxy as plain GETs.
  const prefetch = await proxy(
    new NextRequest(`${ORIGIN}/privacy`, {
      headers: { "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" },
    }),
  );
  assert.match(prefetch.headers.get("set-cookie") ?? "", /__Host-blast_gate=/);
  const fresh = await proxy(
    new NextRequest(withGateCookie(new Request(`${ORIGIN}/privacy`))),
  );
  assert.equal(fresh.headers.get("set-cookie"), null, "a fresh cookie is kept");
  const cookieFromPage = (page.headers.get("set-cookie") ?? "").split(
    ";",
    1,
  )[0]!;
  const after = await proxy(
    new NextRequest(`${ORIGIN}/api/social/feed`, {
      headers: { cookie: cookieFromPage },
    }),
  );
  assert.notEqual(after.status, 401, "the cookie a page sets opens the API");
});

/**
 * Review M4: the gate decides "API or page" from the raw path. Checked on a
 * production build (`next start`, curl --path-as-is, no cookie): the URL
 * parser resolves dot segments and backslashes before the proxy sees them,
 * Next answers `//api/...` and a trailing slash with a 308 to the canonical
 * path, and every other spelling (`/%61pi/...`, `/API/...`, `/api%2F...`)
 * reaches the proxy as a page path, which the route policy rewrites to a
 * fixed page or refuses: none reached an API handler ungated. These pin both
 * halves.
 */
const NORMALIZED_API_VARIANTS = [
  "/./api/social/feed",
  "/api/../api/social/feed",
  "/x/../api/social/feed",
  "/%2e/api/social/feed",
  "/_next/../api/social/feed",
  "/_next/%2e%2e/api/social/feed",
  "/api/social/./feed",
  "/api\\social\\feed",
  "/card/../api/social/feed",
];
const PAGE_SPELLED_API_VARIANTS = [
  "/%61pi/social/feed",
  "/%61%70%69/launchpad/market/status",
  "/%2561pi/social/feed",
  "/API/social/feed",
  "/Api/social/feed",
  "/api%2Fsocial/feed",
  "/api%2fsocial%2ffeed",
  "/%2Fapi/social/feed",
  "/%5capi/social/feed",
  "//api/social/feed",
];

test("review M4: a dot, escape or case spelling of /api never reaches an API route without the gate", async () => {
  const { NextRequest } = await import("next/server");
  const { proxy: handleProxy } = await import("#web/proxy.ts");
  const proxy = (request: Parameters<typeof handleProxy>[0]) =>
    handleProxy(request);
  const { decideMissionControlRoute } = await import(
    "@blast/core/lib/mission-control/route-policy.ts"
  );
  for (const path of NORMALIZED_API_VARIANTS) {
    const request = new NextRequest(`${ORIGIN}${path}`);
    assert.match(
      request.nextUrl.pathname,
      /^\/api\//,
      `${path} is parsed as an API path`,
    );
    const refused = await proxy(request);
    assert.equal(refused.status, 401, path);
    assert.equal(refused.headers.get("x-blast-gate"), "required", path);
  }
  for (const path of PAGE_SPELLED_API_VARIANTS) {
    const request = new NextRequest(`${ORIGIN}${path}`);
    assert.doesNotMatch(
      request.nextUrl.pathname,
      /^\/api(?:\/|$)/,
      `${path} stays a page path`,
    );
    // Under every flag, the route policy never lets such a path through as itself.
    for (let flags = 0; flags < 4; flags += 1) {
      const decision = decideMissionControlRoute(
        request.nextUrl.pathname,
        Boolean(flags & 1),
        Boolean(flags & 2),
      );
      assert.notEqual(decision, "allow", `${path} with flags ${flags}`);
    }
    const answer = await proxy(request);
    assert.equal(
      answer.headers.get("x-middleware-next"),
      null,
      `${path} does not continue to a route`,
    );
    const rewrite = answer.headers.get("x-middleware-rewrite");
    if (rewrite)
      assert.doesNotMatch(
        new URL(rewrite).pathname,
        /^\/api(?:\/|$)/i,
        `${path} is not rewritten to an API route`,
      );
  }
});

class FakeLimiter implements RateLimitPort {
  readonly calls: { bucket: RateBucket; subject: RateLimitSubject }[] = [];
  refuse = new Set<RateBucket>();
  async consume(
    bucket: RateBucket,
    subject: RateLimitSubject,
  ): Promise<RateLimitDecision> {
    this.calls.push({ bucket, subject });
    const allowed = !this.refuse.has(bucket);
    return {
      allowed,
      bucket,
      policyVersion: 1,
      retryAfterSeconds: allowed ? 0 : 42,
    };
  }
}

test("GET /api/gate re-issues the cookie for a same-origin fetch, within web_gate's budget", async () => {
  const limiter = new FakeLimiter();
  const refresh = (
    headers: Record<string, string>,
    port: RateLimitPort | null = limiter,
  ) =>
    gateRefreshResponse(
      api("/api/gate", { headers }),
      testClient("203.0.113.9"),
      {
        expectedOrigin: ORIGIN,
        keys: KEYS,
        limiter: async () => port,
        now: NOW,
      },
    );
  const ok = await refresh({ "sec-fetch-site": "same-origin" });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  const token = (ok.headers.get("set-cookie") ?? "")
    .split(";", 1)[0]!
    .split("=")[1]!;
  assert.equal(gateTokenIssuedAt(token, KEYS, NOW), Math.floor(NOW / 1_000));
  assert.deepEqual(limiter.calls, [
    { bucket: "web_gate", subject: { ip: "203.0.113.9" } },
  ]);

  assert.equal((await refresh({ "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await refresh({})).status, 403);
  assert.equal(
    (
      await refresh({
        "sec-fetch-site": "same-origin",
        origin: "https://evil.example",
      })
    ).status,
    403,
  );
  assert.equal(limiter.calls.length, 1, "a refused request counts nothing");
  limiter.refuse.add("web_gate");
  const limited = await refresh({ "sec-fetch-site": "same-origin" });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "42");
  assert.equal(limited.headers.get("set-cookie"), null);
  assert.equal(
    (await refresh({ "sec-fetch-site": "same-origin" }, null)).status,
    503,
    "no pepper: no cookie",
  );
});

test("the test harness mints a cookie the gate accepts", () => {
  const header = gateCookieHeader(`${ORIGIN}/api/x`, {
    environment: ENV,
    now: NOW,
  });
  assert.match(header, /^__Host-blast_gate=v1\./);
  const request = withGateCookie(
    api("/api/social/me", { headers: { cookie: "a=b" } }),
    { environment: ENV, now: NOW },
  );
  assert.match(
    request.headers.get("cookie") ?? "",
    /^a=b; __Host-blast_gate=v1\./,
  );
  assert.equal(
    apiGateVerdict(request, { gate: GATE, now: NOW }).kind,
    "pass",
  );
});

test("route limits answer 429 with Retry-After, 503 without a limiter, and run the handler otherwise", async () => {
  const limiter = new FakeLimiter();
  const client = testClient("2001:db8:1:2::9");
  const codes = {
    rateLimited: "LAUNCHPAD_RATE_LIMITED",
    unavailable: "LAUNCHPAD_READ_UNAVAILABLE",
  };
  const ran = await withRouteLimits(
    client,
    ["launchpad_search"],
    async () => Response.json({ ok: true }),
    { ...codes, limiter },
  );
  assert.equal(ran.status, 200);
  assert.deepEqual(
    limiter.calls,
    [{ bucket: "launchpad_search", subject: { ip: "2001:db8:1:2::/64" } }],
    "IPv6 counts per /64",
  );
  limiter.refuse.add("launchpad_search");
  const limited = await routeLimitRefusal(client, ["launchpad_search"], {
    ...codes,
    limiter,
  });
  assert.equal(limited?.status, 429);
  assert.equal(limited?.headers.get("retry-after"), "42");
  assert.equal(limited?.headers.get("cache-control"), "no-store");
  assert.deepEqual(await limited?.json(), {
    error: { code: "LAUNCHPAD_RATE_LIMITED", message: "Too many requests." },
  });
  const unavailable = await routeLimitRefusal(client, ["launchpad_search"], {
    ...codes,
    limiter: null,
  });
  assert.equal(unavailable?.status, 503);
  assert.equal(
    ((await unavailable?.json()) as { error: { code: string } }).error.code,
    "LAUNCHPAD_READ_UNAVAILABLE",
  );
  const failing: RateLimitPort = {
    consume: async () => {
      throw new Error("offline");
    },
  };
  assert.equal(
    (
      await routeLimitRefusal(client, ["launchpad_search"], {
        limiter: failing,
      })
    )?.status,
    503,
    "fails closed",
  );
});

/** Every bucket WP3 added, and where it is counted. */
const WIRED: ReadonlyArray<readonly [RateBucket, string]> = [
  ["web_gate", "lib/web-security/gate-refresh.ts"],
  // Public frontend adapters delegate admission to the backend canonical path map.
  ["launchpad_search", "modules/backend-api/public-read-routes.ts"],
  ["launchpad_discovery", "modules/backend-api/public-read-routes.ts"],
  ["launchpad_wallet_launches", "modules/backend-api/public-read-routes.ts"],
  ["launchpad_theses_read", "private/viewer-theses.ts"],
  ["mission_control_owner_read", "modules/mission-control/route-kit.ts"],
  ["mission_control_owner_card", "modules/mission-control/route-kit.ts"],
  ["mission_control_owner_write", "modules/mission-control/route-kit.ts"],
  ["presale_bridge_status", "modules/presale/bridge/routes.ts"],
  ["presale_allowlist_read", "modules/presale/allowlists/routes.ts"],
  ["presale_sponsor_ip", "modules/sponsor/service.ts"],
  ["presale_sponsor_global", "modules/sponsor/service.ts"],
  ["presale_sponsor_exec_ip", "modules/sponsor/execute.ts"],
  ["presale_sponsor_exec_global", "modules/sponsor/execute.ts"],
  // Review H1, H2: counted after the dry run and per reservation.
  ["presale_sponsor_account_daily", "modules/sponsor/service.ts"],
  ["presale_sponsor_bad_signature", "modules/sponsor/execute.ts"],
  // Review M2, M3: API key lookups per IP; the public card image outside /api.
  ["presale_api_key_ip", "modules/presale/route-kit/route.ts"],
  [
    "mission_control_card_image",
    "modules/mission-control/card-images/public-runtime.ts",
  ],
  // Review L3 to L6: the lows' buckets.
  ["wallet_ip", "lib/web-security/rate-limits.ts"],
  ["recovery_ip", "modules/mission-control/crew-access/route.ts"],
  ["social_auth_failure", "modules/social/route-kit/route.ts"],
  ["social_deposit_register", "modules/social/deposits/route.ts"],
  ["social_read_search", "modules/social/search/route.ts"],
  ["social_read_presales", "modules/social/presales/route.ts"],
  ["social_read_prices", "modules/social/prices/route.ts"],
  ["social_read_trade_coins", "modules/social/trades/route.ts"],
  ["social_read_portfolio", "modules/social/portfolio/public-route.ts"],
  ["social_read_quote", "modules/social/trades/route.ts"],
  ["social_trade_quote_anon", "modules/social/trades/route.ts"],
  ["social_me_read", "modules/social/accounts/me-route.ts"],
  ["social_me_read", "modules/social/accounts/settings-route.ts"],
  ["social_me_read", "modules/social/profile-edit/route.ts"],
  ["social_me_read", "modules/social/notifications/route.ts"],
];

/** Read the canonical owner of a route or security primitive. */
function sourceText(file: string): string {
  const owners = [
    new URL(`../../${file}`, import.meta.url),
    new URL(`../../../../../packages/core/src/${file}`, import.meta.url),
    new URL(`../../../../../packages/server/src/${file}`, import.meta.url),
  ];
  const owner = owners.find((candidate) => existsSync(candidate));
  assert.ok(owner, `${file} has a canonical source owner`);
  return readFileSync(owner, "utf8");
}

test("every bucket WP3 added is counted by its route", () => {
  for (const [bucket, file] of WIRED) {
    assert.ok(Object.hasOwn(DEFAULT_RATE_POLICIES, bucket), bucket);
    const source = sourceText(file);
    assert.ok(source.includes(`"${bucket}"`), `${file} counts ${bucket}`);
  }
  const added = new Set(WIRED.map(([bucket]) => bucket));
  for (const bucket of [
    ...WEB_ROUTE_RATE_BUCKETS,
    ...PRESALE_RATE_BUCKETS,
    ...SOCIAL_RATE_BUCKETS,
  ]) {
    if (
      /^(web_gate|launchpad_(search|discovery|theses_read)|mission_control_|presale_(bridge_status|allowlist_read|sponsor_(ip|global|exec_ip|exec_global))|social_(read_|trade_quote_anon|me_read))/.test(
        bucket,
      )
    ) {
      assert.ok(added.has(bucket), `${bucket} is wired`);
    }
  }
  // The anonymous quote's own budget is tight; a signed-in caller keeps the per-account one.
  const trades = sourceText("modules/social/trades/route.ts");
  assert.match(
    trades,
    /context\.consume\(context\.caller \? "social_trade_quote" : "social_trade_quote_anon"\)/,
  );
  assert.equal(
    DEFAULT_RATE_POLICIES.social_trade_quote_anon.windows[0]?.limit,
    20,
  );
});
