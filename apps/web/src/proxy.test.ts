import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test, { before } from "node:test";
import { promisify } from "node:util";

// Next 16.3.1 ships the matcher check under its middleware name; the docs call it unstable_doesProxyMatch.
import { unstable_doesMiddlewareMatch as doesProxyMatch } from "next/experimental/testing/server";

import { config } from "./proxy.ts";

const WEB_ROOT = new URL("../", import.meta.url);
const HOOKS = new URL("../../scripts/test-tsx-hooks.mjs", WEB_ROOT);
const PROXY = new URL("src/proxy.ts", WEB_ROOT);
const GATE_FIXTURES = new URL("test/fixtures/lib/web-security/api-gate-fixtures.ts", WEB_ROOT);
const ORIGIN = "https://www.blast.fun";
const LAUNCH_ID = `0x${"5f".repeat(32)}`;

const LAUNCHPAD_PAGES = ["/coin", `/coin/${LAUNCH_ID}`, "/launch", "/launch/new"];
const LAUNCHPAD_APIS = ["/api/launchpad", "/api/launchpad/csrf", "/api/launchpad/search", "/api/launchpad/launches/feed.json"];
const REMOVED_DEV_PAGES = ["/dev/launchpad", "/dev/social/shell"];
const ROOT_WITH_QUERY = "/?ref=abc&utm_source=x";
const PNL_PAGE = `/card/pnl/${"a".repeat(64)}`;
const PNL_WITH_REFERRAL = `${PNL_PAGE}?ref=nova&utm_source=x`;
const PNL_IMAGE = `${PNL_PAGE}/image`;
// Edge-cached public reads: the proxy must leave them without a cookie or its own Cache-Control.
const PUBLIC_READS = [`/api/launchpad/launch-details/${LAUNCH_ID}?ref=abc`, "/api/launchpad/market/status"];
const PATHS = ["/", ROOT_WITH_QUERY, PNL_PAGE, PNL_WITH_REFERRAL, PNL_IMAGE, "/presale", "/api/presale/presales", "/team", "/privacy", ...LAUNCHPAD_PAGES, ...LAUNCHPAD_APIS, ...REMOVED_DEV_PAGES, ...PUBLIC_READS];

type Answer = Readonly<{
  status: number;
  cacheControl: string | null;
  cookies: string | null;
  location: string | null;
  contentType: string | null;
  requestId: string | null;
  csp: string | null;
  body: string;
  next: boolean;
  rewrite: string | null;
  forwardedNonce: string | null;
  forwardedCsp: string | null;
}>;

// Runs in the child: `server-only` is a bundler marker with no Node entry.
const CHILD = `
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: "data:text/javascript,export {}", shortCircuit: true };
    return next(specifier, context);
  },
});
const { NextRequest } = await import("next/server");
const { proxy } = await import(${JSON.stringify(PROXY.href)});
// API calls carry a valid gate cookie, as a browser's do after a page load (WP3).
const { gateCookieHeader } = await import(${JSON.stringify(GATE_FIXTURES.href)});
const gate = (path, headers) => path.startsWith("/api/") ? { ...headers, cookie: gateCookieHeader(${JSON.stringify(ORIGIN)} + path) } : headers;
const answers = {};
const paths = ${JSON.stringify(PATHS.map((path) => ({ key: path, path })))};
paths.push({ key: "pnl-preview", path: ${JSON.stringify(PNL_WITH_REFERRAL)}, userAgent: "Twitterbot/1.0" });
for (const { key, path, userAgent } of paths) {
  const headers = gate(path, { "user-agent": userAgent ?? "Mozilla/5.0" });
  const response = await proxy(new NextRequest(${JSON.stringify(ORIGIN)} + path, { headers }));
  answers[key] = {
    status: response.status,
    cacheControl: response.headers.get("cache-control"),
    cookies: response.headers.get("set-cookie"),
    location: response.headers.get("location"),
    contentType: response.headers.get("content-type"),
    requestId: response.headers.get("x-request-id"),
    csp: response.headers.get("content-security-policy"),
    body: await response.text(),
    next: response.headers.get("x-middleware-next") === "1",
    rewrite: response.headers.get("x-middleware-rewrite"),
    forwardedNonce: response.headers.get("x-middleware-request-x-nonce"),
    forwardedCsp: response.headers.get("x-middleware-request-content-security-policy"),
  };
}
process.stdout.write(JSON.stringify(answers));
`;

type Flags = Readonly<{ experience?: string }>;

async function throughProxy(flags: Flags): Promise<Record<string, Answer>> {
  const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, NODE_ENV: "test", MISSION_CONTROL_METRICS: "off" };
  if (flags.experience !== undefined) environment.BLAST_EXPERIENCE_ENABLED = flags.experience;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--no-warnings", "--import", HOOKS.href, "--experimental-strip-types", "--input-type=module", "--eval", CHILD],
    { cwd: WEB_ROOT, env: environment, timeout: 120_000 },
  );
  return JSON.parse(stdout) as Record<string, Answer>;
}

const COMBINATIONS: Flags[] = [{}, { experience: "true" }];
const label = (flags: Flags) => `experience=${flags.experience ?? "unset"}`;
const outcomes = new Map<string, Record<string, Answer>>();

before(async () => {
  // One child at a time keeps verification within the host memory budget.
  for (const flags of COMBINATIONS) {
    outcomes.set(label(flags), await throughProxy(flags));
  }
});

function outcome(flags: Flags): Record<string, Answer> {
  const answers = outcomes.get(label(flags));
  assert.ok(answers, label(flags));
  return answers;
}

function nonceOf(csp: string | null): string | undefined {
  return csp?.match(/'nonce-([^']+)'/)?.[1];
}

test("public launchpad and presale routes reach their handlers with the page nonce", () => {
  for (const flags of COMBINATIONS) {
    const answers = outcome(flags);
    for (const path of ["/", ROOT_WITH_QUERY, "/presale", "/api/presale/presales", ...LAUNCHPAD_PAGES, ...LAUNCHPAD_APIS]) {
      const answer = answers[path]!;
      assert.equal(answer.next, true, path);
      assert.equal(answer.rewrite, null, path);
      assert.ok(answer.forwardedNonce, path);
      assert.equal(answer.forwardedNonce, nonceOf(answer.csp), path);
    }
    assert.equal(answers["/team"]!.status, 404);
    assert.equal(answers["/privacy"]!.next, true);
  }
});

test("gated public reads pass the proxy with no Set-Cookie and no Cache-Control of its own, so the edge may share the handler's answer", () => {
  for (const flags of COMBINATIONS) {
    const answers = outcome(flags);
    for (const path of PUBLIC_READS) {
      const answer = answers[path]!;
      assert.equal(answer.next, true, `${path} ${label(flags)}`);
      assert.equal(answer.cookies, null, `${path} ${label(flags)}`);
      assert.equal(answer.cacheControl, null, `${path} ${label(flags)}`);
    }
  }
});

test("the proxy runs on every launchpad path, including dotted paths", () => {
  for (const url of [
    "/",
    "/coin",
    `/coin/${LAUNCH_ID}`,
    `/coin/${LAUNCH_ID}.png`,
    "/launch",
    "/launch/new",
    "/launch/fixture.json",
    "/api/launchpad",
    "/api/launchpad/csrf",
    "/api/launchpad/launches/feed.json",
  ]) {
    assert.equal(doesProxyMatch({ config, nextConfig: {}, url }), true, url);
  }
  for (const url of ["/dev/launchpad/fixture.json", "/dev/launchpad/nested/asset.png"]) {
    assert.equal(doesProxyMatch({ config, nextConfig: {}, url }), false, url);
  }
  // Other public files still skip the proxy.
  assert.equal(doesProxyMatch({ config, nextConfig: {}, url: "/icon-512.png" }), false);
  assert.equal(doesProxyMatch({ config, nextConfig: {}, url: "/dev/other.json" }), false);
});

test("removed development pages answer 404 regardless of launch or experience flags", () => {
  for (const flags of COMBINATIONS) for (const path of REMOVED_DEV_PAGES) {
    const answer = outcome(flags)[path]!;
    assert.equal(answer.status, 404, `${path} ${label(flags)}`);
    assert.equal(answer.rewrite, null, path);
    assert.equal(answer.next, false, path);
  }
});

test("invite queries survive routing and persist a secure, private 30-day attribution cookie", () => {
  const answers = outcome({});
  const invite = answers[ROOT_WITH_QUERY]!;
  assert.match(invite.cookies ?? "", /__Host-blast_referral=abc/);
  assert.match(invite.cookies ?? "", /Max-Age=2592000/);
  assert.match(invite.cookies ?? "", /HttpOnly/);
  assert.match(invite.cookies ?? "", /Secure/);
  assert.match(invite.cookies ?? "", /SameSite=lax/i);
  assert.equal(invite.cacheControl, "private, no-store");
  assert.doesNotMatch(answers["/"]!.cookies ?? "", /__Host-blast_referral/);
});

test("PnL share links open Home with referral attribution under every launch mode", () => {
  assert.equal(doesProxyMatch({ config, nextConfig: {}, url: PNL_WITH_REFERRAL }), true);
  for (const flags of COMBINATIONS) {
    const answer = outcome(flags)[PNL_WITH_REFERRAL]!;
    assert.equal(answer.status, 307, label(flags));
    assert.equal(answer.location, `${ORIGIN}/?ref=nova&utm_source=x`, label(flags));
    assert.match(answer.cookies ?? "", /__Host-blast_referral=nova;/, label(flags));
    assert.equal(answer.cacheControl, "private, no-store", label(flags));
  }
});

test("PnL share links work without a referral and serve social previews and images", () => {
  const answers = outcome({});
  assert.equal(answers[PNL_PAGE]!.location, `${ORIGIN}/`);
  assert.equal(answers[PNL_PAGE]!.cacheControl, "private, no-store");
  assert.equal(answers["pnl-preview"]!.next, true);
  assert.equal(answers[PNL_IMAGE]!.next, true);
});
