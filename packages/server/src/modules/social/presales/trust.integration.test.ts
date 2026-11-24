import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import type { Pool } from "pg";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { advanceWatermark, urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";
import { autocommitReader, withTransaction } from "@blast/core/modules/database/transaction.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import { SOCIAL_CONFIG_DEFAULTS } from "@blast/core/modules/social/contracts/config.ts";
import {
  PRESALE_LIST_SORTS,
  type PresaleListStatus,
  type SocialPresaleDetail,
  type SocialPresaleListPage,
  type SocialPresaleSummary,
  type SocialPresaleViewerResponse,
} from "@blast/core/modules/social/contracts/presales.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { createSocialWatchlistRoutes } from "@blast/server/modules/social/watchlist/route.ts";
import { seedPresaleStory, type PresaleStory } from "../../../../../core/test/fixtures/modules/social/presales/presale-story.ts";
import { createSocialPresaleRoutes } from "@blast/server/modules/social/presales/route.ts";
import { createAdminVerifiedMarkRoute } from "@blast/server/modules/social/admin-verified/route.ts";

/**
 * R3-23 (OA-25 Q8): a sale's trust flags. The verified mark is set and
 * cleared by the admin website's route on the web role, as the backend runs
 * it (Jose 2026-11-21); the operator CLI is run as an operator runs it
 * (`scripts/social-operator.ts` as a child process, as the owning login) for
 * the audited flag, the list and the history; the presale routes read on the
 * replica role and the watchlist on the web role, as in production, over the
 * design's sample sales.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "social-trust-app";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const validator = createSocialValidator();
const POOL = { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 6, statementTimeoutMs: 10_000 };
const NOW = Date.UTC(2026, 9, 3, 18);
const PUBLIC_CACHE = "public, s-maxage=10, stale-while-revalidate=20";
const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const OPERATOR_ID = "ops.trust-test";
const TOKEN = "social-trust-integration-token-32-chars";
const AUTHENTICATED = {
  MISSION_CONTROL_OPERATOR_ALLOWED_ID: OPERATOR_ID,
  MISSION_CONTROL_OPERATOR_TOKEN_SHA256: createHash("sha256").update(TOKEN).digest("hex"),
  BLAST_OPERATOR_ID: OPERATOR_ID,
  BLAST_OPERATOR_TOKEN: TOKEN,
};
/** A reason distinctive enough to find anywhere it leaks. */
const NOTE = "Video call with both founders; passports matched the deck (ticket OPS-4471)";
const ADMIN_CONSOLE = "admin-console";
const ABSENT_PRESALE = `0x${"ee".repeat(32)}`;

function bearer(did: string): string {
  const now = Math.floor(Date.now() / 1_000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: now + 3_600, iat: now - 60, iss: "privy.io", sid: "s-1", sub: did });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `Bearer ${header}.${payload}.${signature.toString("base64url")}`;
}
const KAI = bearer("did:privy:presale-story-kai");

type CliResult = { code: number; stdout: string; stderr: string };
/** The running test's own database; `withFixture` sets it. */
let testDatabaseUrl: string | null = null;

async function cli(args: readonly string[]): Promise<CliResult> {
  assert.ok(testDatabaseUrl);
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, DATABASE_URL: testDatabaseUrl, ...AUTHENTICATED };
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", "scripts/social-operator.ts", ...args],
      { cwd: ROOT, env },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

/** A command that must succeed: its printed result. */
async function ok<T>(args: readonly string[]): Promise<T> {
  const result = await cli(args);
  assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr}`);
  return (JSON.parse(result.stdout) as { result: T }).result;
}

function errorCode(result: CliResult): string | undefined {
  const line = result.stderr.split("\n").find((candidate) => candidate.startsWith('{"error"'));
  return line ? (JSON.parse(line) as { error: { code: string } }).error.code : undefined;
}

type Flags = { verified_team: boolean; audited: boolean };
type ChangeResult = { presale_id: string; before: Flags; after: Flags; changed: boolean };
type MarkResult = { kind: "presale"; target: string; verified: boolean; changed: boolean; log_id: string };
type TrustRow = {
  verified_team: boolean; audited: boolean; verified_by: string | null; verified_at_ms: string | null;
  audited_by: string | null; audited_at_ms: string | null; note: string | null; updated_at_ms: string;
};
type LogRow = { log_id: string; operator_id: string; action: string; target: string; before: unknown; after: unknown; reason: string | null; acted_ms: string };

type Fixture = Readonly<{
  admin: Pool;
  web: Pool;
  story: PresaleStory;
  list(query: string, token?: string): Promise<Response>;
  presale(id: string, token?: string): Promise<Response>;
  viewer(token: string, body: unknown): Promise<Response>;
  watchlist(method: "GET" | "PUT", path: string, token: string): Promise<Response>;
  /** The admin website's change of a sale's verified mark; it must succeed. */
  mark(presaleId: string, verified: boolean, reason: string): Promise<MarkResult>;
  markResponse(body: unknown): Promise<Response>;
}>;

async function withFixture(body: (fixture: Fixture) => Promise<void>): Promise<void> {
  const database = await freshTestDatabase();
  const { url } = database;
  testDatabaseUrl = url;
  const admin = createPool(url, { max: 4 });
  const story = await seedPresaleStory(admin, { nowMs: NOW, crowd: 8 });
  await admin.query(advanceWatermark(70_000, 0, "market"));
  await admin.query(`UPDATE watermarks SET timestamp_ms_hi_inclusive = ${NOW} WHERE pipeline IN ('market', 'presale')`);
  const web = createRuntimePool(urlAs(url, "blast_web"), POOL, "social-trust-web");
  const replicaPool = createRuntimePool(urlAs(url, "blast_replica"), POOL, "social-trust-replica");
  try {
    const kit = createSocialRouteKit({
      tradingVisible: () => true,
      expectedOrigin: ORIGIN,
      verifyAccessToken: createPrivyTokenVerifier({
        appId: APP_ID,
        verificationKey: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
      }),
      limiter: new PostgresRateLimitEnforcer({ pool: web, subjectPepper: "social-trust-pepper-0123456789abcdef" }),
      accounts: new PostgresSocialAccounts(() => web),
      primary: () => web,
    });
    const replica = autocommitReader(replicaPool, "social");
    const primary = autocommitReader(web, "social");
    const presales = createSocialPresaleRoutes({
      kit,
      database: () => replica,
      config: async () => SOCIAL_CONFIG_DEFAULTS,
      terms: async () => null,
      now: () => NOW,
    });
    const watchlist = createSocialWatchlistRoutes({ kit, database: () => primary, now: () => NOW });
    const verifiedMark = createAdminVerifiedMarkRoute(() => web);
    const markResponse = (body: unknown) => verifiedMark(new Request("https://backend.test/api/admin/verified-mark", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    const headers = (token?: string): Record<string, string> =>
      token ? { "x-forwarded-for": "203.0.113.23", authorization: token } : { "x-forwarded-for": "203.0.113.23" };
    await body({
      admin,
      web,
      story,
      list: (query, token) => presales.list.GET(new Request(`${ORIGIN}/api/social/presales${query}`, { headers: headers(token) }), testClient()),
      presale: (id, token) => presales.presale.GET(new Request(`${ORIGIN}/api/social/presales/${id}`, { headers: headers(token) }), testClient()),
      viewer: (token, request) =>
        presales.viewer.POST(new Request(`${ORIGIN}/api/social/presales/viewer`, {
          method: "POST",
          headers: { ...headers(token), "content-type": "application/json" },
          body: JSON.stringify(request),
        }), testClient()),
      watchlist: (method, path, token) => {
        const request = new Request(`${ORIGIN}${path}`, { method, headers: headers(token) });
        return method === "PUT" ? watchlist.item.PUT(request, testClient()) : watchlist.list.GET(request, testClient());
      },
      mark: async (presaleId, verified, reason) => {
        const response = await markResponse({ kind: "presale", target: presaleId, verified, reason });
        const text = await response.text();
        assert.equal(response.status, 200, text);
        return JSON.parse(text) as MarkResult;
      },
      markResponse,
    });
  } finally {
    await Promise.all([admin.end(), web.end(), replicaPool.end()]);
    await database.drop();
    testDatabaseUrl = null;
  }
}

async function publicBody<T>(response: Response, schema: "presale-list-page" | "presale-detail"): Promise<{ body: T; text: string }> {
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const body = JSON.parse(text) as T;
  assert.deepEqual(validator.validate(schema, body).errors, []);
  assert.equal(response.headers.get("cache-control"), schema === "presale-detail" ? "no-store" : PUBLIC_CACHE);
  return { body, text };
}

/** Every sale of every tab, keyed by presale id. */
async function everyRow(fixture: Fixture, token?: string): Promise<Map<string, SocialPresaleSummary>> {
  const rows = new Map<string, SocialPresaleSummary>();
  for (const status of ["live", "upcoming", "ended"] as const) {
    const { body } = await publicBody<SocialPresaleListPage>(await fixture.list(`?status=${status}&limit=50`, token), "presale-list-page");
    for (const row of body.presales) rows.set(row.presale_id, row);
  }
  return rows;
}

const flagsOf = (row: Pick<SocialPresaleSummary, "verified_team" | "audited">): Flags =>
  ({ verified_team: row.verified_team, audited: row.audited });
const NONE: Flags = { verified_team: false, audited: false };

async function trustRow(admin: Pool, presaleId: string): Promise<TrustRow | undefined> {
  return (await admin.query<TrustRow>(
    `SELECT verified_team, audited, verified_by, verified_at_ms::text AS verified_at_ms, audited_by,
       audited_at_ms::text AS audited_at_ms, note, updated_at_ms::text AS updated_at_ms
     FROM social_sale_trust WHERE presale_id = $1`,
    [presaleId],
  )).rows[0];
}

async function trustLog(admin: Pool): Promise<LogRow[]> {
  return (await admin.query<LogRow>(
    `SELECT log_id::text AS log_id, operator_id, action, target, before, after, reason,
       (extract(epoch FROM acted_at) * 1000)::bigint::text AS acted_ms
     FROM social_operator_log WHERE action LIKE 'sale.trust.%' ORDER BY acted_at, log_id`,
  )).rows;
}

async function snapshot(admin: Pool) {
  const [trust, log] = await Promise.all([
    admin.query("SELECT * FROM social_sale_trust ORDER BY presale_id"),
    admin.query("SELECT * FROM social_operator_log ORDER BY acted_at, log_id"),
  ]);
  return { trust: trust.rows, log: log.rows };
}

test("R3-23-AC-1/AC-2: no row reads false everywhere; the admin website sets verified_team with a reason; who, when and why stay in the log, never in a response", { skip }, () =>
  withFixture(async (fixture) => {
    const { admin, story } = fixture;
    const meridian = story.presaleIds.MRDN!;

    // AC-2: a sale with no trust row reads every flag false, in every tab and on its page.
    const before = await everyRow(fixture);
    assert.equal(before.size, Object.keys(story.presaleIds).length);
    for (const [id, row] of before) assert.deepEqual(flagsOf(row), NONE, id);
    assert.deepEqual(flagsOf((await publicBody<SocialPresaleDetail>(await fixture.presale(meridian), "presale-detail")).body.presale), NONE);

    const set = await fixture.mark(meridian.toUpperCase().replace("0X", "0x"), true, NOTE);
    assert.deepEqual({ ...set, log_id: null }, { kind: "presale", target: meridian, verified: true, changed: true, log_id: null });

    // The row: who and when, the reason as its note. The log: who, when, why, before and after, in the same transaction.
    const row = await trustRow(admin, meridian);
    assert.ok(row);
    assert.deepEqual(
      { ...row, verified_at_ms: null, updated_at_ms: null },
      { verified_team: true, audited: false, verified_by: ADMIN_CONSOLE, verified_at_ms: null, audited_by: null, audited_at_ms: null, note: NOTE, updated_at_ms: null },
    );
    const [entry, ...others] = await trustLog(admin);
    assert.equal(others.length, 0);
    assert.deepEqual(
      { ...entry, log_id: null, acted_ms: null },
      { log_id: null, operator_id: ADMIN_CONSOLE, action: "sale.trust.set", target: meridian, before: NONE, after: { ...NONE, verified_team: true }, reason: NOTE, acted_ms: null },
    );
    assert.equal(entry!.log_id, set.log_id);
    assert.equal(row.verified_at_ms, entry!.acted_ms, "the row's time is the log row's");
    assert.equal(row.updated_at_ms, entry!.acted_ms);

    // The payloads: the flag as true for that sale only, the same for a visitor and a signed-in reader.
    const visitor = await everyRow(fixture);
    for (const [id, summary] of visitor) {
      assert.deepEqual(flagsOf(summary), id === meridian ? { ...NONE, verified_team: true } : NONE, id);
    }
    assert.deepEqual(await everyRow(fixture, KAI), visitor);
    const detail = await publicBody<SocialPresaleDetail>(await fixture.presale(meridian), "presale-detail");
    assert.deepEqual(flagsOf(detail.body.presale), { ...NONE, verified_team: true });
    const signedIn = await publicBody<SocialPresaleDetail>(await fixture.presale(meridian, KAI), "presale-detail");
    assert.deepEqual({ ...signedIn.body, as_of: null }, { ...detail.body, as_of: null });

    // Captured bodies of every route that carries a presale row: the list, the sale page, the viewer's rows and the watchlist.
    const bodies: string[] = [detail.text, signedIn.text];
    for (const query of ["?status=live", "?status=live&verified_team=true", "?status=upcoming", "?status=ended&sort=best"]) {
      bodies.push((await publicBody<SocialPresaleListPage>(await fixture.list(query), "presale-list-page")).text);
    }
    const viewer = await fixture.viewer(KAI, { status: "live" });
    const viewerText = await viewer.text();
    assert.equal(viewer.status, 200, viewerText);
    assert.deepEqual(validator.validate("presale-viewer-response", JSON.parse(viewerText)).errors, []);
    const viewerRows = (JSON.parse(viewerText) as SocialPresaleViewerResponse).rows ?? [];
    assert.ok(viewerRows.some((summary) => summary.presale_id === meridian && summary.verified_team), "the viewer's rows carry the flag");
    bodies.push(viewerText);
    assert.equal((await fixture.watchlist("PUT", `/api/social/me/watchlist/${meridian}`, KAI)).status, 204);
    const starred = await fixture.watchlist("GET", "/api/social/me/watchlist", KAI);
    const starredText = await starred.text();
    assert.equal(starred.status, 200, starredText);
    assert.deepEqual(validator.validate("watchlist-page", JSON.parse(starredText)).errors, []);
    assert.ok(starredText.includes('"verified_team":true'), "the watchlist (blast_web, primary) reads the flag too");
    bodies.push(starredText);
    for (const text of bodies) {
      for (const secret of [NOTE, "OPS-4471", ADMIN_CONSOLE, row.verified_at_ms!, "verified_by", "verified_at", "audited_by", '"note"', "updated_at_ms"]) {
        assert.ok(!text.includes(secret), `a response carries ${secret}`);
      }
    }
  }));

test("R3-23: set and clear each flag; a repeat is a logged no-op that keeps its setter; history and list page by keyset", { skip }, () =>
  withFixture(async (fixture) => {
    const { admin, story } = fixture;
    const [cobalt, kestrel, sable] = [story.presaleIds.CBLT!, story.presaleIds.KSTL!, story.presaleIds.SABL!];

    await ok(["sale", "trust", "set", cobalt, "--audited", "--reason", "read the Halborn report"]);
    const audited = await trustRow(admin, cobalt);
    assert.equal(audited?.audited_by, OPERATOR_ID);
    assert.equal(audited?.verified_by, null, "an unset flag names nobody");
    // OA-26: the LP lock is protocol-wide, so no payload carries a per-sale flag for it.
    assert.equal("lp_locked" in (await publicBody<SocialPresaleDetail>(await fixture.presale(cobalt), "presale-detail")).body.presale, false);

    // Setting a set flag again changes nothing, not even its time or the note, and is logged as a no-op.
    const repeat = await ok<ChangeResult>(["sale", "trust", "set", cobalt, "--audited", "--reason", "again"]);
    assert.equal(repeat.changed, false);
    assert.deepEqual(await trustRow(admin, cobalt), audited);

    assert.equal((await fixture.mark(cobalt, true, "KYC passed")).changed, true);
    assert.equal((await trustRow(admin, cobalt))?.audited_by, OPERATOR_ID, "the mark leaves the audited flag and its setter alone");
    const cleared = await ok<ChangeResult>(["sale", "trust", "clear", cobalt, "--audited", "--reason", "the report covered another commit"]);
    assert.deepEqual(cleared.after, { verified_team: true, audited: false });
    const after = await trustRow(admin, cobalt);
    assert.equal(after?.audited_by, null, "a cleared flag names nobody: who cleared it is in the log");
    assert.equal(after?.audited_at_ms, null);
    assert.equal(after?.verified_by, ADMIN_CONSOLE);
    assert.equal(after?.note, "the report covered another commit");
    assert.deepEqual(flagsOf((await everyRow(fixture)).get(cobalt)!), { verified_team: true, audited: false });

    // Clearing a sale with no row is a logged no-op: no row appears.
    assert.equal((await fixture.mark(sable, false, "nothing to clear")).changed, false);
    assert.equal(await trustRow(admin, sable), undefined);

    // History: this sale's four changes, newest first, paged by keyset; reads are logged but are not changes.
    type History = { presale_id: string; changes: { log_id: string; operator_id: string; action: string; reason: string; after: Flags }[]; next: string | null };
    const history = await ok<History>(["sale", "trust", "history", cobalt]);
    assert.deepEqual(history.changes.map((change) => [change.action, change.reason]), [
      ["sale.trust.clear", "the report covered another commit"],
      ["sale.trust.set", "KYC passed"],
      ["sale.trust.set", "again"],
      ["sale.trust.set", "read the Halborn report"],
    ]);
    assert.deepEqual(history.changes.map((change) => change.operator_id), [OPERATOR_ID, ADMIN_CONSOLE, OPERATOR_ID, OPERATOR_ID]);
    assert.equal(history.next, null);
    const first = await ok<History>(["sale", "trust", "history", cobalt, "--limit", "3"]);
    assert.equal(first.changes.length, 3);
    const rest = await ok<History>(["sale", "trust", "history", cobalt, "--limit", "3", "--before", first.next!]);
    assert.deepEqual([...first.changes, ...rest.changes].map((change) => change.log_id), history.changes.map((change) => change.log_id));
    assert.equal(rest.next, null);

    // List: every sale with a row, by id, paged by keyset.
    await fixture.mark(kestrel, true, "both checked");
    await ok(["sale", "trust", "set", kestrel, "--audited", "--reason", "both checked"]);
    type List = { sales: { presale_id: string; note: string | null; verified_by: string | null }[]; next: string | null };
    const all = await ok<List>(["sale", "trust", "list"]);
    assert.deepEqual(all.sales.map((sale) => sale.presale_id), [cobalt, kestrel].sort());
    assert.equal(all.sales.find((sale) => sale.presale_id === kestrel)?.note, "both checked", "the operator sees the note; no browser does");
    const page = await ok<List>(["sale", "trust", "list", "--limit", "1"]);
    const next = await ok<List>(["sale", "trust", "list", "--limit", "1", "--after", page.next!]);
    assert.deepEqual([...page.sales, ...next.sales].map((sale) => sale.presale_id), all.sales.map((sale) => sale.presale_id));
    assert.equal(next.next, null);
  }));

test("R3-23: a refused change (no reason, an unknown sale, a bad flag, the CLI's --verified) changes nothing and logs nothing", { skip }, () =>
  withFixture(async (fixture) => {
    const { admin, story } = fixture;
    const meridian = story.presaleIds.MRDN!;
    await fixture.mark(meridian, true, NOTE);
    const before = await snapshot(admin);
    for (const [args, code] of [
      [["sale", "trust", "set", meridian, "--audited"], "OPERATOR_INPUT_INVALID"],
      [["sale", "trust", "clear", meridian, "--verified"], "OPERATOR_INPUT_INVALID"],
      [["sale", "trust", "set", meridian, "--lp", "--reason", "x"], "OPERATOR_INPUT_INVALID"],
      // OA-26: no operator records the LP lock; it is true of every sale.
      [["sale", "trust", "set", meridian, "--lp-locked", "--reason", "x"], "OPERATOR_INPUT_INVALID"],
      [["sale", "trust", "set", ABSENT_PRESALE, "--audited", "--reason", "no such sale"], "OPERATOR_TARGET_NOT_FOUND"],
      [["sale", "trust", "clear", ABSENT_PRESALE, "--audited", "--reason", "no such sale"], "OPERATOR_TARGET_NOT_FOUND"],
      // Jose 2026-11-21: the verified mark is the admin website's alone.
      [["sale", "trust", "clear", meridian, "--verified", "--reason", "x"], "OPERATOR_INPUT_INVALID"],
      [["sale", "trust", "set", story.presaleIds.CBLT!, "--verified", "--reason", "x"], "OPERATOR_INPUT_INVALID"],
    ] as const) {
      const result = await cli(args);
      assert.notEqual(result.code, 0, args.join(" "));
      assert.equal(errorCode(result), code, args.join(" "));
      assert.equal(result.stdout, "");
    }
    for (const [body, status] of [
      [{ kind: "presale", target: ABSENT_PRESALE, verified: true, reason: "no such sale" }, 404],
      [{ kind: "presale", target: ABSENT_PRESALE, verified: false, reason: "no such sale" }, 404],
      [{ kind: "presale", target: meridian, verified: false }, 400],
      [{ kind: "presale", target: meridian, verified: false, reason: " " }, 400],
      [{ kind: "presale", target: meridian, verified: false, reason: "x", audited: false }, 400],
      [{ kind: "presale", target: "0xabc", verified: true, reason: "x" }, 400],
    ] as const) {
      assert.equal((await fixture.markResponse(body)).status, status, JSON.stringify(body));
    }
    assert.deepEqual(await snapshot(admin), before);
  }));

test("R3-23-AC-5: the list's two filters return exactly the flagged sales of every tab and sort, and page by keyset", { skip }, () =>
  withFixture(async (fixture) => {
    const { story } = fixture;
    const ids = story.presaleIds;
    // The gate's own flags: verified Meridian, Tidal, Sable, Cobalt, Kestrel; audited all of those but Tidal.
    for (const symbol of ["MRDN", "SABL", "CBLT", "KSTL", "TIDE"]) await fixture.mark(ids[symbol]!, true, "gate");
    for (const symbol of ["MRDN", "SABL", "CBLT", "KSTL"]) await ok(["sale", "trust", "set", ids[symbol]!, "--audited", "--reason", "gate"]);

    const statuses: PresaleListStatus[] = ["live", "upcoming", "ended"];
    const filters = [
      ["verified_team=true", (row: SocialPresaleSummary) => row.verified_team],
      ["audited=true", (row: SocialPresaleSummary) => row.audited],
      ["verified_team=true&audited=true", (row: SocialPresaleSummary) => row.verified_team && row.audited],
    ] as const;
    const kept = new Set<string>();
    for (const status of statuses) {
      for (const sort of PRESALE_LIST_SORTS[status]) {
        const all = (await publicBody<SocialPresaleListPage>(await fixture.list(`?status=${status}&sort=${sort}&limit=50`), "presale-list-page")).body.presales;
        async function assertFilteredPages(query: string, keep: (row: SocialPresaleSummary) => boolean) {
          const filtered = (await publicBody<SocialPresaleListPage>(
            await fixture.list(`?status=${status}&sort=${sort}&limit=50&${query}`), "presale-list-page",
          )).body.presales;
          assert.deepEqual(filtered.map((row) => row.presale_id), all.filter(keep).map((row) => row.presale_id), `${status} ${sort} ${query}`);
          for (const row of filtered) kept.add(row.name);
          // One row per page: the keyset walks exactly the same sales.
          const walked: string[] = [];
          let cursor: string | null = null;
          do {
            const next: SocialPresaleListPage = (await publicBody<SocialPresaleListPage>(
              await fixture.list(`?status=${status}&sort=${sort}&limit=1&${query}${cursor ? `&cursor=${cursor}` : ""}`), "presale-list-page",
            )).body;
            walked.push(...next.presales.map((row) => row.presale_id));
            cursor = next.next_cursor;
          } while (cursor !== null && walked.length < 20);
          assert.deepEqual(walked, filtered.map((row) => row.presale_id), `${status} ${sort} ${query}, paged`);
        }
        for (const [query, keep] of filters) await assertFilteredPages(query, keep);
      }
    }
    assert.deepEqual([...kept].sort(), ["Cobalt", "Kestrel", "Meridian", "Sable", "Tidal"]);

    // A filter takes `true` only; a sale whose flag is not set is never in its answer.
    for (const query of ["?verified_team=1", "?audited=false", "?verified_team=true&verified_team=true"]) {
      const response = await fixture.list(query);
      assert.equal(response.status, 400, query);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
  }));

test("R3-23-AC-3/AC-4: every web write path runs as blast_web, which may write only the verified mark (0165), never the audited flag or a delete; a refused write leaves the row as it was", { skip }, () =>
  withFixture(async (fixture) => {
    const { admin, web, story } = fixture;
    const meridian = story.presaleIds.MRDN!;
    await fixture.mark(meridian, true, NOTE);
    await ok(["sale", "trust", "set", meridian, "--audited", "--reason", NOTE]);
    const before = await snapshot(admin);
    // What any route's transaction would run, through the social module's own write path (R3-24's
    // sale-metadata route included): the module owns the table, so only PostgreSQL's privileges refuse it.
    for (const sql of [
      `INSERT INTO social_sale_trust (presale_id, audited, audited_by, audited_at_ms, updated_at_ms) VALUES ('${story.presaleIds.ONDN}', TRUE, 'web', 1, 1)`,
      `UPDATE social_sale_trust SET audited = FALSE, audited_by = NULL, audited_at_ms = NULL WHERE presale_id = '${meridian}'`,
      `DELETE FROM social_sale_trust WHERE presale_id = '${meridian}'`,
      `INSERT INTO social_sale_trust (presale_id, updated_at_ms) VALUES ('${meridian}', 1) ON CONFLICT (presale_id) DO UPDATE SET audited = TRUE`,
    ]) {
      await assert.rejects(
        withTransaction(web, async (context) => context.forModule("social").write("social_sale_trust", sql), { label: "r3-23.web-write" }),
        { code: "42501" },
        sql,
      );
    }
    assert.deepEqual(await snapshot(admin), before);
  }));
