import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test, { before } from "node:test";
import { promisify } from "node:util";

// Next 16.3.1 ships the matcher check under its middleware name; the docs call it unstable_doesProxyMatch.
import { unstable_doesMiddlewareMatch as doesProxyMatch } from "next/experimental/testing/server";

import { createPresaleValidator } from "@blast/core/modules/presale/contracts/validate.ts";
import { PresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";
import { config } from "./proxy.ts";

/**
 * T-031 (AC-138, AC-139): the proxy over the launchpad flag. The presale
 * configuration is read once per process, so each flag setting runs in its own
 * Node process, which sends every path below through `proxy` and reports what
 * it answered.
 */

const WEB_ROOT = new URL("../", import.meta.url);
const HOOKS = new URL("../../scripts/test-tsx-hooks.mjs", WEB_ROOT);
const PROXY = new URL("src/proxy.ts", WEB_ROOT);
const GATE_FIXTURES = new URL("test/fixtures/lib/web-security/api-gate-fixtures.ts", WEB_ROOT);
const ORIGIN = "https://www.blast.fun";
const LAUNCH_ID = `0x${"5f".repeat(32)}`;
const validator = createPresaleValidator();

const LAUNCHPAD_PAGES = ["/coin", `/coin/${LAUNCH_ID}`, "/launch", "/launch/new"];
const LAUNCHPAD_APIS = ["/api/launchpad", "/api/launchpad/csrf", "/api/launchpad/search", "/api/launchpad/launches/feed.json"];
const REMOVED_DEV_PAGES = ["/dev/launchpad", "/dev/social/shell"];
const ROOT_WITH_QUERY = "/?ref=abc&utm_source=x";
const PNL_PAGE = `/card/pnl/${"a".repeat(64)}`;
const PNL_WITH_REFERRAL = `${PNL_PAGE}?ref=nova&utm_source=x`;
const PNL_IMAGE = `${PNL_PAGE}/image`;
const PATHS = ["/", ROOT_WITH_QUERY, PNL_PAGE, PNL_WITH_REFERRAL, PNL_IMAGE, "/presale", "/api/presale/presales", "/team", "/privacy", ...LAUNCHPAD_PAGES, ...LAUNCHPAD_APIS, ...REMOVED_DEV_PAGES];

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
  forwardedHome: string | null;
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
  // A client-sent home marker is never forwarded: only the proxy sets it.
  const headers = gate(path, { "x-blast-home-rewrite": "1", "user-agent": userAgent ?? "Mozilla/5.0" });
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
    forwardedHome: response.headers.get("x-middleware-request-x-blast-home-rewrite"),
  };
}
process.stdout.write(JSON.stringify(answers));
`;

type Flags = Readonly<{ launchpad?: string; experience?: string; presale?: string }>;

async function throughProxy(flags: Flags): Promise<Record<string, Answer>> {
  const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, NODE_ENV: "test", MISSION_CONTROL_METRICS: "off" };
  if (flags.launchpad !== undefined) environment.BLAST_LAUNCHPAD_ENABLED = flags.launchpad;
  if (flags.experience !== undefined) environment.BLAST_EXPERIENCE_ENABLED = flags.experience;
  if (flags.presale !== undefined) environment.BLAST_PRESALE_ENABLED = flags.presale;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--no-warnings", "--import", HOOKS.href, "--experimental-strip-types", "--input-type=module", "--eval", CHILD],
    { cwd: WEB_ROOT, env: environment, timeout: 120_000 },
  );
  return JSON.parse(stdout) as Record<string, Answer>;
}

const OFF = [undefined, "false", "TRUE", "1"] as const;
const EXPERIENCE = [undefined, "true"] as const;
const PRESALE = [undefined, "true"] as const;
const label = (flags: Flags) =>
  `launchpad=${flags.launchpad ?? "unset"} experience=${flags.experience ?? "unset"} presale=${flags.presale ?? "unset"}`;

const COMBINATIONS: Flags[] = [...OFF, "true"].flatMap((launchpad) =>
  EXPERIENCE.flatMap((experience) => PRESALE.map((presale) => ({ launchpad, experience, presale }))),
);
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

function assertEmptyNotFound(answer: Answer, message: string): void {
  assert.equal(answer.status, 404, message);
  assert.equal(answer.cacheControl, "no-store", message);
  assert.equal(answer.body, "", message);
  assert.equal(answer.requestId, null, `${message}: page 404s do not create API diagnostics`);
  assert.equal(answer.next, false, message);
  assert.equal(answer.rewrite, null, message);
  assert.ok(nonceOf(answer.csp), `${message}: the 404 still carries the CSP`);
}

test("T-031-AC-1: with the launchpad off, launchpad pages answer the empty 404 and its APIs the published not_found, under every flag", () => {
  for (const launchpad of OFF) {
    for (const experience of EXPERIENCE) {
      for (const presale of PRESALE) {
        const flags = { launchpad, experience, presale };
        const answers = outcome(flags);
        for (const path of LAUNCHPAD_PAGES) assertEmptyNotFound(answers[path]!, `${path} ${label(flags)}`);
        for (const path of LAUNCHPAD_APIS) {
          const answer = answers[path]!;
          const message = `${path} ${label(flags)}`;
          assert.equal(answer.status, 404, message);
          assert.match(answer.requestId ?? "", /^[a-f0-9-]{36}$/, message);
          assert.equal(answer.cacheControl, "no-store", message);
          assert.match(answer.contentType ?? "", /^application\/json/, message);
          assert.equal(answer.next, false, message);
          const body: unknown = JSON.parse(answer.body);
          assert.deepEqual(validator.validate("errors/not_found", body).errors, [], message);
          // The same body, message included, that a presale route answers for not_found.
          assert.deepEqual(body, new PresaleRouteError("not_found").body(), message);
        }
      }
    }
  }
});

test("T-031-AC-2: with the launchpad off and the presale on, / is rewritten to /presale and forwards the nonce its CSP names", () => {
  for (const launchpad of OFF) {
    for (const experience of EXPERIENCE) {
      const flags = { launchpad, experience, presale: "true" };
      const root = outcome(flags)["/"]!;
      const message = label(flags);
      assert.equal(root.status, 200, message);
      assert.equal(root.rewrite, `${ORIGIN}/presale`, message);
      assert.equal(root.next, false, message);
      const nonce = nonceOf(root.csp);
      assert.ok(nonce, message);
      assert.equal(root.forwardedNonce, nonce, `${message}: x-nonce equals the response CSP's nonce`);
      assert.equal(root.forwardedCsp, root.csp, `${message}: Next reads its script nonce from the request CSP`);
      // The query string survives the rewrite.
      const query = outcome(flags)[ROOT_WITH_QUERY]!;
      assert.equal(query.rewrite, `${ORIGIN}/presale?ref=abc&utm_source=x`, message);
      assert.equal(query.forwardedNonce, nonceOf(query.csp), message);
      // `/presale` itself, for comparison: let through.
      assert.equal(outcome(flags)["/presale"]!.next, true, message);
    }
  }
});

test("with the launchpad and the presale off, / is today's home page (production main's): a rewrite to /mission, marked as home", () => {
  for (const launchpad of OFF) {
    for (const experience of EXPERIENCE) {
      const flags = { launchpad, experience, presale: undefined };
      const answers = outcome(flags);
      for (const [path, target] of [["/", "/mission"], [ROOT_WITH_QUERY, "/mission?ref=abc&utm_source=x"]] as const) {
        const answer = answers[path]!;
        const message = `${path} ${label(flags)}`;
        assert.equal(answer.status, 200, message);
        assert.equal(answer.rewrite, `${ORIGIN}${target}`, message);
        assert.equal(answer.next, false, message);
        assert.ok(nonceOf(answer.csp), message);
        assert.equal(answer.forwardedNonce, nonceOf(answer.csp), message);
        assert.equal(answer.forwardedHome, "1", message);
      }
      assertEmptyNotFound(answers["/presale"]!, `/presale ${label(flags)}`);
      // Nowhere else is the home marker forwarded, even when the client sends it.
      for (const path of PATHS.filter((candidate) => candidate !== "/" && candidate !== ROOT_WITH_QUERY)) {
        assert.equal(answers[path]!.forwardedHome, null, `${path} ${label(flags)}`);
      }
      // The presale API's not-found carries the published body.
      const api = answers["/api/presale/presales"]!;
      assert.equal(api.status, 404);
      assert.deepEqual(validator.validate("errors/not_found", JSON.parse(api.body)).errors, []);
      assert.deepEqual(JSON.parse(api.body), new PresaleRouteError("not_found").body());
    }
  }
});

test("T-031-AC-1: with the launchpad on (exactly true), / and every launchpad path are let through as on the base", () => {
  for (const experience of EXPERIENCE) {
    for (const presale of PRESALE) {
      const flags = { launchpad: "true", experience, presale };
      const answers = outcome(flags);
      for (const path of ["/", ROOT_WITH_QUERY, ...LAUNCHPAD_PAGES, ...LAUNCHPAD_APIS]) {
        const answer = answers[path]!;
        assert.equal(answer.next, true, `${path} ${label(flags)}`);
        assert.equal(answer.rewrite, null, `${path} ${label(flags)}`);
        assert.equal(answer.forwardedNonce, nonceOf(answer.csp), `${path} ${label(flags)}`);
      }
    }
  }
});

test("the launchpad flag changes nothing for /team and /privacy", () => {
  for (const experience of EXPERIENCE) {
    for (const presale of PRESALE) {
      for (const path of ["/team", "/privacy"]) {
        const on = outcome({ launchpad: "true", experience, presale })[path]!;
        const off = outcome({ launchpad: undefined, experience, presale })[path]!;
        assert.equal(off.status, on.status, path);
        assert.equal(off.next, on.next, path);
        assert.equal(off.rewrite, on.rewrite, path);
      }
    }
  }
});

test("T-031-AC-1: the proxy runs on every launchpad path, dotted ones included, so the flag gates them all", () => {
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
  const answers = outcome({ launchpad: "true", experience: undefined, presale: "true" });
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
  const answers = outcome({ launchpad: "true", experience: undefined, presale: "true" });
  assert.equal(answers[PNL_PAGE]!.location, `${ORIGIN}/`);
  assert.equal(answers[PNL_PAGE]!.cacheControl, "private, no-store");
  assert.equal(answers["pnl-preview"]!.next, true);
  assert.equal(answers[PNL_IMAGE]!.next, true);
});
