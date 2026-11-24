import { testClient } from "../../../../../../packages/core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { primaryPool, replicaPool } from "@blast/core/modules/database/pool.ts";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";

import { endProcessPools } from "../../../../../../packages/core/test/fixtures/modules/database/testing.ts";
import { installRuntimeConfig } from "../../../../../../packages/server/test/fixtures/config/runtime-config.ts";
import { SOCIAL_PORTFOLIO_PATH, SOCIAL_PORTFOLIO_ROUTE, SOCIAL_PUBLIC_PORTFOLIO_ROUTE } from "@blast/core/modules/social/contracts/portfolio.ts";

/** A file of this module, by its `./name`: here in the web app, or in core. */
const moduleFile = (file: string) => {
  if (file.startsWith("@blast/")) return new URL(import.meta.resolve(file));
  const web = new URL(file, import.meta.url);
  const server = new URL(file, new URL(import.meta.resolve("@blast/server/modules/social/portfolio/runtime.ts")));
  return existsSync(web) ? web : existsSync(server) ? server : new URL(file, new URL("../../../../../../packages/core/src/modules/social/portfolio/", import.meta.url));
};

/**
 * Social-feed T-019 (AC-110, AC-111, AC-124, AC-165): the production wiring.
 * Every owner portfolio read takes the primary pool, never the replica; the
 * owner's route is `/api/social/me/portfolio`, with no dynamic segment and no
 * parameter. Coin pages and PnL since launch stay owner-scoped; public portfolio
 * and PnL reads use the opt-in callsign routes. The production route answers 401 without a
 * token, private and no-store, before touching anything.
 */

// `server-only` is a bundler marker with no Node entry; outside Next it is empty.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: "data:text/javascript,export {}", shortCircuit: true };
    return next(specifier, context);
  },
});

const PRIMARY = "postgresql://app:app-secret@127.0.0.1:9/never_connected";
const REPLICA = "postgresql://reader:reader-secret@127.0.0.1:9/never_connected?application_name=replica";
const API_ROOT = new URL("../../../app/api/", import.meta.url);

function withEnvironment(t: TestContext, values: Record<string, string | undefined>): void {
  installRuntimeConfig(values);
  t.after(endProcessPools);
}

async function routeFiles(directory: URL, prefix = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) found.push(...(await routeFiles(new URL(`${entry.name}/`, directory), `${path}/`)));
    else if (/^route\.(ts|tsx|js)$/.test(entry.name)) found.push(path);
  }
  return found;
}

test("T-019-AC-2 (AC-165): every portfolio read takes the primary pool, never the replica", async (t) => {
  withEnvironment(t, { DATABASE_URL: PRIMARY, DATABASE_REPLICA_URL: REPLICA });
  const primary = primaryPool();
  assert.equal(primary.options.connectionString, PRIMARY);
  assert.notEqual(primary, replicaPool());

  const source = await readFile(new URL(import.meta.resolve("@blast/server/modules/social/portfolio/runtime.ts")), "utf8");
  // The route's database and its wallet lister both sit on primaryPool.
  assert.match(source, /autocommitReader\(primaryPool\(\), "social"/);
  assert.match(source, /database: socialPortfolioDatabase/);
  assert.match(source, /wallets: socialAccounts\(\)/);
  assert.doesNotMatch(source, /replicaPool|"replica"|socialProfile|databaseFor\(/);
  const accounts = await readFile(new URL(import.meta.resolve("@blast/server/modules/social/route-kit/shared-runtime.ts")), "utf8");
  assert.match(accounts, /new PostgresSocialAccounts\(primaryPool\)/);
  // The route reads only what it is given: no pool of its own.
  for (const file of ["@blast/server/modules/social/portfolio/route.ts", "@blast/core/modules/social/portfolio/read.ts", "../../../../../workers/src/modules/social/portfolio/balances.ts"]) {
    const code = await readFile(moduleFile(file), "utf8");
    assert.doesNotMatch(code, /databaseFor|Pool\b/, file);
  }
});

test("T-019-AC-2 (AC-165): without a replica configured the portfolio still has its database: it never needs the replica", async (t) => {
  withEnvironment(t, { DATABASE_URL: PRIMARY, DATABASE_REPLICA_URL: undefined });
  assert.throws(() => replicaPool(), /DATABASE_REPLICA_URL is required/);
  const { socialPortfolioDatabase, socialPortfolioRoute } = await import("@blast/server/modules/social/portfolio/runtime.ts");
  assert.equal(typeof socialPortfolioDatabase().read, "function");
  assert.equal(typeof socialPortfolioRoute().GET, "function");
});

test("T-019-AC-1 (AC-110, amended by OA-10): portfolio and PnL routes are owner-scoped or opt-in public reads by callsign", async () => {
  assert.equal(SOCIAL_PORTFOLIO_ROUTE, "GET /api/social/me/portfolio");
  assert.equal(SOCIAL_PORTFOLIO_PATH, "/api/social/me/portfolio");
  assert.equal(SOCIAL_PUBLIC_PORTFOLIO_ROUTE, "GET /api/social/profiles/{callsign}/portfolio");
  const files = await routeFiles(API_ROOT);
  assert.ok(files.length > 20);
  const portfolio: string[] = [];
  for (const file of files) {
    if (/portfolio/i.test(file) || /\/pnl\/route\.ts$/.test(file)) portfolio.push(file);
  }
  assert.deepEqual(portfolio.sort(), [
    "social/me/pnl/route.ts",
    "social/me/portfolio/coins/route.ts",
    "social/me/portfolio/history/route.ts",
    "social/me/portfolio/route.ts",
    "social/profiles/[callsign]/pnl/route.ts",
    "social/profiles/[callsign]/portfolio/history/route.ts",
    "social/profiles/[callsign]/portfolio/route.ts",
  ]);

  const route = await readFile(new URL("social/me/portfolio/route.ts", API_ROOT), "utf8");
  assert.match(route, /export const GET = backendPrivateRequest/);
  assert.doesNotMatch(route, /export (async )?function (POST|PUT|PATCH|DELETE)|params|searchParams/);
  // Query parameters may shape the response, but cannot select its account or wallets.
  const handler = await readFile(new URL(import.meta.resolve("@blast/server/modules/social/portfolio/route.ts")), "utf8");
  const ownHandler = handler.slice(handler.indexOf("export function createSocialPortfolioRoute"));
  const queryKeys = [...ownHandler.matchAll(/(?:params|searchParams)\.get\("([^"]+)"\)/g)].map((match) => match[1]);
  assert.deepEqual(queryKeys.sort(), ["hide_small", "page", "q", "view"]);
  assert.match(ownHandler, /auth: "account", account: "required"/);
  assert.match(ownHandler, /wallets\.wallets\(account\.account_id\)/);
  // OA-10: the public read is GET only, names an account by callsign alone (never a wallet or an
  // account id), never reads the caller, and refuses unless the owner opted in and is public.
  const publicRoute = await readFile(new URL("social/profiles/[callsign]/portfolio/route.ts", API_ROOT), "utf8");
  assert.match(publicRoute, /export const GET = backendPrivateRequest/);
  assert.doesNotMatch(publicRoute, /export (async )?function (POST|PUT|PATCH|DELETE)/);
  const publicHandler = await readFile(new URL(import.meta.resolve("@blast/server/modules/social/portfolio/public-route.ts")), "utf8");
  // OA-30: shared at the edge 10 s, never stale (amending R3-32-AC-7).
  assert.match(publicHandler, /auth: "none", bucket: "social_read_portfolio", cache: "public-fresh"/);
  assert.match(publicHandler, /if \(owner\.private \|\| !owner\.portfolio_public\) throw new SocialRouteError\("portfolio_private"\)/);
  assert.doesNotMatch(publicHandler, /context\.caller|context\.account/);
  // The one query read is the history's range (#534); none can select the account or its wallets.
  assert.equal(publicHandler.replace("portfolioHistoryRange(new URL(context.request.url).searchParams)", "").includes("searchParams"), false);
  assert.ok(files.every((file) => !/portfolio/i.test(file) || !/\[/.test(file) || file === "social/profiles/[callsign]/portfolio/route.ts" || file === "social/profiles/[callsign]/portfolio/history/route.ts"));
  assert.equal(fileURLToPath(new URL("social/me/portfolio/route.ts", API_ROOT)).includes("["), false);
});

test("T-019-AC-2 (AC-111, AC-124): the production route without a token is 401, private and no-store, with no portfolio field", async (t) => {
  withEnvironment(t, { DATABASE_URL: PRIMARY, DATABASE_REPLICA_URL: REPLICA });
  const { socialPortfolioRoute } = await import("@blast/server/modules/social/portfolio/runtime.ts");
  const { GET } = socialPortfolioRoute();
  for (const headers of [{}, { authorization: "Bearer" }, { authorization: "Token abc" }] as Record<string, string>[]) {
    const response = await GET(new Request("https://blast.fun/api/social/me/portfolio", { headers }), testClient());
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.ok(response.headers.get("x-request-id"));
    const body = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body), ["error"]);
    assert.equal((body.error as { code: string }).code, "unauthorized");
  }
});
