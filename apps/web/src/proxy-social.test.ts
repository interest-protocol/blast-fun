import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test, { before } from "node:test";
import { promisify } from "node:util";

import { createPresaleValidator } from "@blast/core/modules/presale/contracts/validate.ts";
import { PresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";

/**
 * T-006 (AC-121, AC-122): the proxy over the social flag. The presale
 * configuration is read once per process, so each flag setting runs in its own
 * Node process, which sends every path below through `proxy` and reports what
 * it answered.
 */

const WEB_ROOT = new URL("../", import.meta.url);
const HOOKS = new URL("../../scripts/test-tsx-hooks.mjs", WEB_ROOT);
const PROXY = new URL("src/proxy.ts", WEB_ROOT);
const GATE_FIXTURES = new URL("test/fixtures/lib/web-security/api-gate-fixtures.ts", WEB_ROOT);
const ORIGIN = "https://www.blast.fun";
const INFRA_ORIGIN = "https://infra.blast.fun";
const validator = createPresaleValidator();

const ROOT_WITH_QUERY = "/?ref=abc&utm_source=x";
// UI-02/03: `/p/<post id>` is a post permalink, let through like `/crew/*`.
const SOCIAL_PAGES = ["/crew/kai", "/feed", "/p/a-1200-0-0-0"];
const SOCIAL_APIS = ["/api/social/me", "/api/social"];
/** OA-4: profiles live at `/@<callsign>`; `|marked` sends the rewrite's own marker header. */
const PROFILE_PATHS = ["/@kai", "/@kai?tab=calls", "/crew/kai?tab=calls", "/crew/kai|marked"];
const PATHS = ["/", ROOT_WITH_QUERY, ...SOCIAL_PAGES, ...SOCIAL_APIS, ...PROFILE_PATHS, "/presale", "/sign-in", "/privacy"];

type Answer = Readonly<{
  status: number;
  cacheControl: string | null;
  contentType: string | null;
  csp: string | null;
  body: string;
  next: boolean;
  rewrite: string | null;
  location: string | null;
  forwardedProfileRewrite: string | null;
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
for (const path of ${JSON.stringify(PATHS)}) {
  const [target, mark] = path.split("|");
  const headers = mark === "marked" ? { "x-blast-profile-rewrite": "1" } : {};
  const response = await proxy(new NextRequest(${JSON.stringify(ORIGIN)} + target, { headers: gate(target, headers) }));
  answers[path] = {
    status: response.status,
    cacheControl: response.headers.get("cache-control"),
    contentType: response.headers.get("content-type"),
    csp: response.headers.get("content-security-policy"),
    body: await response.text(),
    next: response.headers.get("x-middleware-next") === "1",
    rewrite: response.headers.get("x-middleware-rewrite"),
    location: response.headers.get("location"),
    forwardedProfileRewrite: response.headers.get("x-middleware-request-x-blast-profile-rewrite"),
    forwardedNonce: response.headers.get("x-middleware-request-x-nonce"),
    forwardedCsp: response.headers.get("x-middleware-request-content-security-policy"),
  };
}
process.stdout.write(JSON.stringify(answers));
`;

type Flags = Readonly<{ social?: string; experience?: string }>;

async function throughProxy(flags: Flags): Promise<Record<string, Answer>> {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    NODE_ENV: "test",
    MISSION_CONTROL_METRICS: "off",
    // Configured both ways (the deprecated public name too): the CSP must still name neither.
    BLAST_INFRA_ORIGIN: INFRA_ORIGIN,
    NEXT_PUBLIC_BLAST_INFRA_ORIGIN: INFRA_ORIGIN,
  };
  if (flags.social !== undefined) environment.BLAST_SOCIAL_ENABLED = flags.social;
  if (flags.experience !== undefined) environment.BLAST_EXPERIENCE_ENABLED = flags.experience;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--no-warnings", "--import", HOOKS.href, "--experimental-strip-types", "--input-type=module", "--eval", CHILD],
    { cwd: WEB_ROOT, env: environment, timeout: 120_000 },
  );
  return JSON.parse(stdout) as Record<string, Answer>;
}

const SOCIAL = [undefined, "TRUE", "true"] as const;
const OFF = [undefined, "TRUE"] as const;
const EXPERIENCE = [undefined, "true"] as const;
const label = (flags: Flags) =>
  `social=${flags.social ?? "unset"} experience=${flags.experience ?? "unset"}`;

const COMBINATIONS = SOCIAL.flatMap((social) => EXPERIENCE.map((experience) => ({ social, experience })));
const outcomes = new Map<string, Record<string, Answer>>();

before(async () => {
  for (const flags of COMBINATIONS) outcomes.set(label(flags), await throughProxy(flags));
});

function outcome(flags: Flags): Record<string, Answer> {
  const answers = outcomes.get(label(flags));
  assert.ok(answers, label(flags));
  return answers;
}

function nonceOf(csp: string | null): string | undefined {
  return csp?.match(/'nonce-([^']+)'/)?.[1];
}

function connectSources(csp: string | null): string[] {
  const directive = csp?.split(";").map((part) => part.trim()).find((part) => part.startsWith("connect-src "));
  return directive?.split(/\s+/).slice(1) ?? [];
}

/** The answer without its per-request nonce, for comparing two processes' answers. */
function comparable(answer: Answer) {
  const { csp, forwardedNonce, forwardedCsp, ...rest } = answer;
  const nonce = nonceOf(csp) ?? "";
  const strip = (value: string | null) => value?.replaceAll(nonce, "<nonce>") ?? null;
  return { ...rest, csp: strip(csp), forwardedNonce: strip(forwardedNonce), forwardedCsp: strip(forwardedCsp) };
}

function assertJsonNotFound(answer: Answer, message: string): void {
  assert.equal(answer.status, 404, message);
  assert.equal(answer.cacheControl, "no-store", message);
  assert.match(answer.contentType ?? "", /^application\/json/, message);
  assert.equal(answer.next, false, message);
  assert.equal(answer.rewrite, null, message);
  const body: unknown = JSON.parse(answer.body);
  assert.deepEqual(validator.validate("errors/not_found", body).errors, [], message);
  assert.deepEqual(body, new PresaleRouteError("not_found").body(), message);
}

test("T-006-AC-1: with the social feed and the presale on, / is rewritten to the feed with its nonce, /crew/* and /api/social/* are let through", () => {
  for (const experience of EXPERIENCE) {
    const flags = { social: "true", experience };
    const answers = outcome(flags);
    const message = label(flags);
    const root = answers["/"]!;
    assert.equal(root.status, 200, message);
    // An internal rewrite: the browser keeps `/` in its address bar.
    assert.equal(root.rewrite, `${ORIGIN}/feed`, message);
    assert.equal(root.next, false, message);
    const nonce = nonceOf(root.csp);
    assert.ok(nonce, message);
    assert.equal(root.forwardedNonce, nonce, `${message}: x-nonce equals the response CSP's nonce`);
    assert.equal(root.forwardedCsp, root.csp, `${message}: Next reads its script nonce from the request CSP`);
    assert.equal(answers[ROOT_WITH_QUERY]!.rewrite, `${ORIGIN}/feed?ref=abc&utm_source=x`, message);
    for (const path of [...SOCIAL_PAGES, ...SOCIAL_APIS]) {
      // OA-4: the profile page's own path redirects (tested below).
      if (path === "/crew/kai") continue;
      const answer = answers[path]!;
      assert.equal(answer.next, true, `${path} ${message}`);
      assert.equal(answer.rewrite, null, `${path} ${message}`);
      assert.equal(answer.forwardedNonce, nonceOf(answer.csp), `${path} ${message}`);
    }
    // The presale's own pages are untouched.
    assert.equal(answers["/presale"]!.next, true, message);
    assert.equal(answers["/sign-in"]!.next, true, message);
  }
});

test("OA-4: with the social feed on, /@<callsign> is the profile page under its address and /crew/<callsign> redirects there", () => {
  for (const experience of EXPERIENCE) {
    const flags = { social: "true", experience };
    const answers = outcome(flags);
    const message = label(flags);
    for (const [path, target] of [["/@kai", "/crew/kai"], ["/@kai?tab=calls", "/crew/kai?tab=calls"]] as const) {
      const answer = answers[path]!;
      assert.equal(answer.status, 200, `${path} ${message}`);
      assert.equal(answer.rewrite, `${ORIGIN}${target}`, `${path} ${message}`);
      assert.equal(answer.forwardedNonce, nonceOf(answer.csp), `${path} ${message}`);
      assert.equal(answer.forwardedProfileRewrite, "1", `${path} ${message}`);
    }
    for (const [path, location] of [["/crew/kai", "/@kai"], ["/crew/kai?tab=calls", "/@kai?tab=calls"]] as const) {
      const answer = answers[path]!;
      assert.equal(answer.status, 307, `${path} ${message}`);
      assert.equal(answer.location, `${ORIGIN}${location}`, `${path} ${message}`);
      assert.ok(nonceOf(answer.csp), `${path} ${message}: the redirect carries the CSP too`);
    }
    // The page request behind the rewrite reaches the proxy as /crew/kai with the marker: served, not redirected.
    const marked = answers["/crew/kai|marked"]!;
    assert.equal(marked.next, true, message);
    assert.equal(marked.location, null, message);
  }
});

test("WP2: no page may connect to blast-infra or its /v1/ws socket: the browser reads market data from this app", () => {
  const answers = outcome({ social: "true" });
  for (const path of ["/", "/@kai", "/feed"]) {
    const sources = connectSources(answers[path]!.csp);
    assert.ok(!sources.some((source) => source.includes("infra.blast.fun")), `${path}: ${sources.join(" ")}`);
  }
});

test("invalid social settings behave like the default", () => {
  for (const experience of EXPERIENCE) {
    const unset = outcome({ experience });
    const invalid = outcome({ social: "TRUE", experience });
    for (const path of PATHS) assert.deepEqual(comparable(invalid[path]!), comparable(unset[path]!), path);
    assert.equal(unset["/crew/kai"]!.rewrite, `${ORIGIN}/mission`);
    assert.equal(unset["/"]!.next, true);
  }
});

test("T-006-AC-2: with the social feed off, /api/social/* answers the published not_found JSON body", () => {
  for (const social of OFF) {
    for (const experience of EXPERIENCE) {
      const flags = { social, experience };
      for (const path of SOCIAL_APIS) assertJsonNotFound(outcome(flags)[path]!, `${path} ${label(flags)}`);
    }
  }

});
