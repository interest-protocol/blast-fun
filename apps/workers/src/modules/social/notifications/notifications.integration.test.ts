import { testClient } from "../../../../../../packages/core/test/fixtures/lib/web-security/client-address.ts";
import { withSocialCoverage } from "../../../../test/fixtures/modules/social/worker/shared-evidence-fixture.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import type { Pool } from "pg";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { seedChainRead, type ChainActivityRow, type ChainPresaleRow } from "../../../../../../packages/core/test/fixtures/modules/database/chain-read-rows.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { FIXTURE_NETWORK, FIXTURE_FINGERPRINT, advanceWatermark, urlAs } from "../../../../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../../packages/core/test/fixtures/modules/database/template.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import type { SocialNotification, SocialNotificationPage } from "@blast/core/modules/social/contracts/notifications.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { createSocialAlerts } from "#workers/modules/social/worker/alerts.ts";
import { createSocialWorker, type SocialWorker } from "../worker/runtime.ts";
import { notificationSteps } from "#workers/modules/social/notifications/generate.ts";
import { createSocialNotificationRoutes } from "@blast/server/modules/social/notifications/route.ts";
import { hex, uuid } from "../../../../../../packages/core/test/kit.ts";

/**
 * UI-13 notifications end to end on a disposable database: the generator
 * steps on the social worker runtime as `blast_watcher` over the fixture
 * `chain_read_v1` views (idempotent, watermark-bounded, preference-aware,
 * fanned out on write), then the routes as `blast_web` with a real Privy
 * token verifier and the Postgres rate limiter.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "social-notifications-app";
const PEPPER = "social-notifications-fixture-pepper-0123456789";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const verificationKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
const validator = createSocialValidator();
const POOL = { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 4, statementTimeoutMs: 5_000 };
const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Date.now();

const P1 = hex("e1d1a");
const P2 = hex("5ab1e");
const P3 = hex("c0ba17");
const P4 = hex("71da1");
/** Shared with a scheduled start still ahead: open on chain, taking commitments only from its start. */
const P_SCHEDULED = hex("5c4ed");
const ACCOUNTS = {
  kai: { id: uuid(1), did: "did:privy:notify-kai", callsign: "kaimoreno", name: "Kai Moreno", wallet: hex("a1") },
  mira: { id: uuid(2), did: "did:privy:notify-mira", callsign: "mirachen", name: "Mira Chen", wallet: hex("a2") },
  hidden: { id: uuid(3), did: "did:privy:notify-hidden", callsign: "hidden_one", name: "Hidden One", wallet: hex("a3") },
  nadia: { id: uuid(4), did: "did:privy:notify-nadia", callsign: "nadia", name: "Nadia Petrova", wallet: hex("a4") },
  bob: { id: uuid(5), did: "did:privy:notify-bob", callsign: "bob_b", name: "Bob", wallet: hex("a5") },
} as const;

function token(did: string): string {
  const now = Math.floor(Date.now() / 1_000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: now + 3_600, iat: now - 60, iss: "privy.io", sid: "s-1", sub: did });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

function presale(id: string, name: string, symbol: string, overrides: Partial<ChainPresaleRow> = {}): ChainPresaleRow {
  return {
    presale_id: id, sale_token: `${id}::coin::${symbol}`, quote_type: `${hex("dc")}::usdc::USDC`, sale_symbol: symbol, sale_name: name,
    sale_icon_url: `https://cdn.blast.fun/${symbol.toLowerCase()}.png`, sale_decimals: 9, quote_symbol: "USDC", quote_decimals: 6,
    lifecycle: "open", start_ms: NOW - 2 * DAY, end_ms: NOW + 6 * HOUR + 12 * 60_000, raise_target: "1000000000", min_commitment: "1000000",
    wallet_cap: null, total_commitments: "0", participants: 0, venue: "bluefin", pool_id: null, updated_checkpoint: 1_000,
    ...overrides,
  };
}

let slot = 0;
function commit(checkpoint: number, actor: string, fields: Partial<ChainActivityRow> = {}): ChainActivityRow {
  slot += 1;
  return {
    checkpoint, tx_slot: slot, event_slot: 0, part: 0, timestamp_ms: NOW - 2 * HOUR + (checkpoint - 1_000) * 60_000,
    digest: `Nt${slot}`.padEnd(44, "1"), kind: "presale_commit", product: "presale", actor, tx_sender: actor, presale_id: P1,
    coin_type: null, quote_type: `${hex("dc")}::usdc::USDC`, quote_amount: "100000000", coin_amount: null, quote_refund: null,
    usd_value: "100", usd_price_as_of_ms: null, venue: null, participants_after: 2, total_commitments_after: "300000000",
    ...fields,
  };
}
const activityId = (row: ChainActivityRow) => `${row.checkpoint}:${row.tx_slot}:${row.event_slot}:${row.part}`;

type Fixture = Readonly<{
  admin: Pool;
  watcher: Pool;
  web: Pool;
  worker: () => SocialWorker;
  routes: ReturnType<typeof createSocialNotificationRoutes>;
  logs: Array<Record<string, unknown>>;
}>;

async function withDatabase(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const database = await freshTestDatabase();
  const admin = createPool(database.url, { max: 4 });
  const watcher = createRuntimePool(urlAs(database.url, "blast_watcher"), POOL, "notify-watcher-test");
  const web = createRuntimePool(urlAs(database.url, "blast_web"), POOL, "notify-web-test");
  const logs: Array<Record<string, unknown>> = [];
  try {
    for (const account of Object.values(ACCOUNTS)) {
      await admin.query(
        `INSERT INTO social_accounts (account_id, privy_did, callsign, display_name, x_handle, onboarding_shown_at, onboarded_at, privacy, sharing_since)
         VALUES ($1, $2, $3, $4, $5, now(), now(), $6, $7)`,
        [account.id, account.did, account.callsign, account.name, account === ACCOUNTS.mira ? "mirachen" : null,
          account === ACCOUNTS.hidden ? "private" : "public", account === ACCOUNTS.hidden ? null : new Date(NOW - 30 * DAY)],
      );
      await admin.query("INSERT INTO social_account_wallets (address, account_id, kind, verified_at) VALUES ($1, $2, 'external', $3)", [
        account.wallet, account.id, new Date(NOW - 60 * DAY),
      ]);
    }
    const follow = (follower: string, kind: "account" | "presale", target: string) =>
      admin.query("INSERT INTO social_follows (follower_account_id, target_kind, target_id, source) VALUES ($1, $2, $3, 'user')", [follower, kind, target]);
    await follow(ACCOUNTS.kai.id, "account", ACCOUNTS.mira.id);
    await follow(ACCOUNTS.kai.id, "account", ACCOUNTS.hidden.id);
    await follow(ACCOUNTS.nadia.id, "account", ACCOUNTS.mira.id);
    await follow(ACCOUNTS.kai.id, "presale", P1);
    await follow(ACCOUNTS.kai.id, "presale", P2);
    await follow(ACCOUNTS.kai.id, "presale", P_SCHEDULED);
    await follow(ACCOUNTS.nadia.id, "presale", P1);
    // Nadia turned "People you follow" and "80% filled" off.
    await admin.query("INSERT INTO social_notification_preferences (account_id, people_you_follow, almost_full) VALUES ($1, false, false)", [ACCOUNTS.nadia.id]);
    await seedChainRead(admin, {
      presales: [
        presale(P1, "Meridian", "MRDN"),
        presale(P2, "Sable", "SABL", { lifecycle: "pending", start_ms: NOW + 30 * 60_000, end_ms: NOW + 10 * DAY }),
        presale(P_SCHEDULED, "Ondine", "ONDN", { lifecycle: "open", start_ms: NOW + 40 * 60_000, end_ms: NOW + 10 * DAY }),
        presale(P3, "Cobalt", "CBLT", { lifecycle: "funded", total_commitments: "1250000000", end_ms: NOW - HOUR }),
        presale(P4, "Tidal", "TIDE", { end_ms: NOW + 30 * 60_000, total_commitments: "730000000" }),
      ],
      presale_positions: [
        { presale_id: P1, wallet: ACCOUNTS.kai.wallet, commitment: "100000000", last_commit_ms: NOW - DAY, claim_digest: null, claimed_tokens: null, claimed_quote_refund: null, claimed_ms: null },
        { presale_id: P1, wallet: ACCOUNTS.bob.wallet, commitment: "50000000", last_commit_ms: NOW - DAY, claim_digest: null, claimed_tokens: null, claimed_quote_refund: null, claimed_ms: null },
        { presale_id: P4, wallet: ACCOUNTS.kai.wallet, commitment: "250000000", last_commit_ms: NOW - DAY, claim_digest: null, claimed_tokens: null, claimed_quote_refund: null, claimed_ms: null },
        { presale_id: P3, wallet: ACCOUNTS.kai.wallet, commitment: "500000000", last_commit_ms: NOW - DAY, claim_digest: null, claimed_tokens: null, claimed_quote_refund: null, claimed_ms: null },
        { presale_id: P3, wallet: ACCOUNTS.bob.wallet, commitment: "70000000", last_commit_ms: NOW - DAY, claim_digest: "ClaimedAlready".padEnd(44, "1"), claimed_tokens: "1", claimed_quote_refund: "0", claimed_ms: NOW - HOUR },
      ],
      vesting_schedules: [
        { schedule_id: hex("5c1"), presale_id: P3, beneficiary: hex("7ea"), total: "1000", claimed: "0", start_ms: NOW + 7 * DAY - 30 * 60_000, cliff_ms: "0", end_ms: String(NOW + 7 * DAY - 30 * 60_000 + 365 * DAY) },
      ],
    });
    // The presale pipeline starts at checkpoint 1,000, two hours behind.
    await admin.query(advanceWatermark(1_000, 2 * HOUR, "presale"));
    const accounts = new PostgresSocialAccounts(() => web);
    const kit = createSocialRouteKit({
      tradingVisible: () => true,
      expectedOrigin: ORIGIN,
      verifyAccessToken: createPrivyTokenVerifier({ appId: APP_ID, verificationKey }),
      limiter: new PostgresRateLimitEnforcer({ pool: web, subjectPepper: PEPPER }),
      accounts,
      primary: () => web,
    });
    const log = (metric: string, fields: Record<string, unknown> = {}) => void logs.push({ metric, ...fields });
    let holder = 0;
    const worker = () => {
      holder += 1;
      return withSocialCoverage(createSocialWorker({
        selection: { network: FIXTURE_NETWORK, deployment: FIXTURE_FINGERPRINT },
        pool: watcher,
        steps: notificationSteps({ batchSize: 2, retentionDays: 90, unlockLeadDays: 7, participantMilestones: async () => [3, 10, 50] }),
        config: { intervalMs: 50, maxBackoffMs: 400, leaseTtlMs: 5_000 },
        holder: `00000000-0000-4000-8000-${holder.toString(16).padStart(12, "0")}`,
        log,
        alerts: createSocialAlerts({ webhookUrl: null, log }),
      }), admin);
    };
    await run({ admin, watcher, web, worker, routes: createSocialNotificationRoutes({ kit }), logs });
  } finally {
    await Promise.all([watcher.end(), web.end()]);
    await admin.end();
    await database.drop();
  }
}

type Stored = { account_id: string; kind: string; source_key: string; data: Record<string, unknown> };

async function stored(admin: Pool): Promise<Stored[]> {
  const { rows } = await admin.query<Stored>("SELECT account_id::text, kind, source_key, data FROM social_notifications ORDER BY source_key, account_id");
  return rows;
}

const keysOf = (rows: readonly Stored[]) => rows.map((row) => `${row.account_id === ACCOUNTS.kai.id ? "kai" : row.account_id === ACCOUNTS.bob.id ? "bob" : row.account_id === ACCOUNTS.nadia.id ? "nadia" : row.account_id}|${row.source_key}`).sort();

/** Runs passes until one writes nothing (each pass reads at most `batchSize` commits). */
async function drain(worker: SocialWorker): Promise<number> {
  let total = 0;
  for (let index = 0; index < 20; index += 1) {

    const report = await worker.runPass();
    assert.equal(report.outcome, "ok");
    total += report.counts.notifications_written;
    if (report.counts.notifications_written === 0 && index > 0) return total;
  }
  return total;
}

function request(did: string | null, path: string, method = "GET"): Request {
  return new Request(`${ORIGIN}${path}`, { method, headers: did ? { authorization: `Bearer ${token(did)}` } : {} });
}

async function json<Body>(response: Response, schema: "notification-page" | "notification-unread-response" | "notification-unread-newest-response" | "error", status = 200): Promise<Body> {
  const body: unknown = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  assert.deepEqual(validator.validate(schema, body).errors, []);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  return body as Body;
}

test("UI-13: notifications are generated once per recipient and event, within the watermark, by preference", { skip }, () =>
  withDatabase(async ({ admin, worker }) => {
    const history = commit(990, ACCOUNTS.mira.wallet);
    await seedChainRead(admin, { activity: [history] });
    // Old rows are dropped by retention on the first pass (it runs at most every ten minutes).
    await admin.query(
      `INSERT INTO social_notifications (account_id, kind, source_key, presale_id, occurred_at_ms, data)
       VALUES ($1, 'funded', 'funded:old', $2, $3, '{}')`,
      [ACCOUNTS.kai.id, P1, NOW - 100 * DAY],
    );
    const first = worker();
    // The first pass starts every cursor at the watermark: history is not notified.

    const opening = await first.runPass();
    assert.equal(opening.counts.notifications_written, 0);
    assert.equal(opening.counts.notifications_deleted, 1);

    const miraBig = commit(1_001, ACCOUNTS.mira.wallet, { usd_value: "2000.4", quote_amount: "2000000000" });
    const hidden = commit(1_002, ACCOUNTS.hidden.wallet);
    const tenth = commit(1_003, ACCOUNTS.bob.wallet, { participants_after: 10, total_commitments_after: "750000000" });
    const crossing = commit(1_004, ACCOUNTS.bob.wallet, { participants_after: 10, total_commitments_after: "850000000" });
    const beyond = commit(1_100, ACCOUNTS.mira.wallet, { participants_after: 11, total_commitments_after: "900000000" });
    await seedChainRead(admin, { activity: [miraBig, hidden, tenth, crossing, beyond] });
    // The watermark moves to 1,050 (chain time now): commits at 1,001 to 1,004 are visible, 1,100 is not.
    await admin.query(advanceWatermark(1_050, 0, "presale"));

    await first.runPass();
    await drain(first);
    const kai = ACCOUNTS.kai.id;
    assert.deepEqual(keysOf(await stored(admin)), [
      "bob|fill:" + P1 + ":filled:80",
      "bob|fill:" + P1 + ":participants:10",
      "kai|fill:" + P1 + ":filled:80",
      "kai|fill:" + P1 + ":participants:10",
      `kai|follow:${activityId(miraBig)}`,
      `kai|soon:${P4}:closes`,
      `bob|unlock:${P3}:${NOW + 7 * DAY - 30 * 60_000}`,
      `kai|soon:${P2}:opens`,
      `kai|soon:${P_SCHEDULED}:opens`,
      `kai|unlock:${P3}:${NOW + 7 * DAY - 30 * 60_000}`,
    ].sort(), "the private actor is never named, Nadia's switches are off, history and the 1,100 commit are not read, the old row is gone");
    const rows = await stored(admin);
    const followRow = rows.find((row) => row.kind === "follow")!;
    assert.deepEqual(followRow.data, { usd: "2000" });
    assert.deepEqual(rows.find((row) => row.account_id === kai && row.source_key.endsWith("participants:10"))!.data, { m: "participants", v: 10, pct: 75, c: "100000000" });
    assert.deepEqual(rows.find((row) => row.account_id === ACCOUNTS.bob.id && row.source_key.endsWith("filled:80"))!.data, { m: "filled", v: 80, c: "50000000" });
    const cursor = (await admin.query<{ value: { c: number } }>("SELECT value FROM social_worker_state WHERE name = 'notify-activity'")).rows[0]!.value;
    assert.ok(cursor.c <= 1_050, "the cursor never passes the watermark");

    // Idempotent: more passes, a replayed cursor and a restarted worker write nothing new.
    const before = (await stored(admin)).length;
    assert.equal(await drain(first), 0);
    await admin.query(
      "UPDATE social_worker_state SET value = jsonb_build_object('c', 989, 't', 0, 'e', 0, 'p', 0, 'ts', $1::bigint) WHERE name = 'notify-activity'",
      [history.timestamp_ms],
    );
    await admin.query("UPDATE social_worker_state SET value = jsonb_build_object('ms', $1::bigint) WHERE name = 'notify-clock'", [NOW - 3 * HOUR]);
    await first.release();
    const restarted = worker();
    await drain(restarted);
    // The replay reads history (990) now: it names Mira, a new event for Kai; everything else is a conflict.
    const replayed = keysOf(await stored(admin));
    assert.equal(replayed.length, before + 1);
    assert.ok(replayed.includes(`kai|follow:${activityId(history)}`));

    // The watermark reaches 1,100: the later commit is notified once.
    await admin.query(advanceWatermark(1_200, 0, "presale"));
    await drain(restarted);
    assert.ok(keysOf(await stored(admin)).includes(`kai|follow:${activityId(beyond)}`));

    // Lifecycle: Cobalt funded then migrated. Bob already claimed, so only Kai hears claims are open.
    await seedChainRead(admin, {
      presale_lifecycle: [
        { presale_id: P3, state: "funded", digest: "Fund".padEnd(44, "1"), timestamp_ms: NOW - HOUR, checkpoint: 1_250 },
        { presale_id: P3, state: "migrated", digest: "Migr".padEnd(44, "1"), timestamp_ms: NOW - 30 * 60_000, checkpoint: 1_260 },
      ],
    });
    await admin.query(advanceWatermark(1_255, 0, "presale"));
    await drain(restarted);
    let keys = keysOf(await stored(admin));
    assert.ok(keys.includes(`kai|funded:${P3}`) && keys.includes(`bob|funded:${P3}`));
    assert.ok(!keys.some((key) => key.includes("claim:")), "the migration at 1,260 is past the watermark");
    await admin.query(advanceWatermark(1_300, 0, "presale"));
    await drain(restarted);
    keys = keysOf(await stored(admin));
    assert.ok(keys.includes(`kai|claim:${P3}`));
    assert.ok(!keys.includes(`bob|claim:${P3}`));
    await restarted.release();
  }));

test("UI-13: the routes page, count and mark read the caller's own notifications only", { skip }, () =>
  withDatabase(async ({ admin, routes, worker }) => {
    const w = worker();
    await w.runPass();
    const miraBig = commit(1_001, ACCOUNTS.mira.wallet, { usd_value: "2000", quote_amount: "2000000000" });
    const tenth = commit(1_003, ACCOUNTS.bob.wallet, { participants_after: 10, total_commitments_after: "750000000" });
    await seedChainRead(admin, { activity: [miraBig, tenth] });
    await admin.query(
      `INSERT INTO social_whys (why_id, entry_id, author_account_id, text) VALUES ($1, $2, $3, 'Been using their app for months')`,
      [uuid(0x77), `a:${activityId(miraBig)}`, ACCOUNTS.mira.id],
    );
    await admin.query(advanceWatermark(1_050, 0, "presale"));
    await drain(w);
    await w.release();
    const kai = ACCOUNTS.kai.did;

    const page = await json<SocialNotificationPage>(await routes.page.GET(request(kai, "/api/social/me/notifications"), testClient()), "notification-page");
    assert.equal(page.unread_count, page.items.length);
    assert.equal(page.next_cursor, null);
    const byKind = (kind: string) => page.items.filter((item) => item.kind === kind);
    const follow = byKind("follow")[0]!;
    assert.equal(follow.title, "Mira blasted $2,000 into Meridian");
    assert.equal(follow.sub, "“Been using their app for months”");
    assert.deepEqual(follow.actor, { callsign: "mirachen", display_name: "Mira Chen", avatar_url: null, verified: true });
    assert.equal(follow.href, `/presale/${P1}`);
    const milestone = byKind("fill").find((item) => item.title.includes("backers"))!;
    assert.equal(milestone.title, "Meridian passed 10 backers");
    assert.equal(milestone.sub, "You have $100 in · 8 hours remained when sent");
    assert.equal(byKind("soon").find((item) => item.title.startsWith("Sable"))?.sub, "You asked to be notified");
    assert.deepEqual(byKind("soon").find((item) => item.title.startsWith("Last hour"))?.sub, "You have $250 in · 73% filled");
    assert.match(byKind("unlock")[0]!.title, /^Cobalt team unlock in (7|6) days$/);
    assert.equal(byKind("unlock")[0]!.sub, "Linear over 365 d from launch");
    const times = page.items.map((item) => item.occurred_at_ms);
    assert.deepEqual(times, [...times].sort((a, b) => b - a), "newest event first");

    // Keyset paging: two at a time, every item once.
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : "?limit=2";
      const part: SocialNotificationPage = await json<SocialNotificationPage>(await routes.page.GET(request(kai, `/api/social/me/notifications${query}`), testClient()), "notification-page");
      seen.push(...part.items.map((item: SocialNotification) => item.id));
      cursor = part.next_cursor;
    } while (cursor);
    assert.deepEqual(seen, page.items.map((item) => item.id));
    await json(await routes.page.GET(request(kai, "/api/social/me/notifications?cursor=bogus"), testClient()), "error", 400);
    await json(await routes.page.GET(request(kai, "/api/social/me/notifications?limit=51"), testClient()), "error", 400);

    // Unread count, one read, someone else's id, all read.
    const unread = async (did: string) =>
      (await json<{ unread_count: number }>(await routes.unread.GET(request(did, "/api/social/me/notifications/unread"), testClient()), "notification-unread-response")).unread_count;
    assert.equal(await unread(kai), page.items.length);
    // `?newest=1` adds the highest unread ID: what a polling tab compares to spot a new alert.
    const newest = async (did: string) =>
      json<{ unread_count: number; newest_unread_id: string | null }>(
        await routes.unread.GET(request(did, "/api/social/me/notifications/unread?newest=1"), testClient()),
        "notification-unread-newest-response",
      );
    const highestId = (ids: readonly string[]) => ids.reduce<string | null>((max, id) => max === null || BigInt(id) > BigInt(max) ? id : max, null);
    assert.deepEqual(await newest(kai), { unread_count: page.items.length, newest_unread_id: highestId(page.items.map((item) => item.id)) });
    const one = await json<{ unread_count: number }>(
      await routes.markRead.POST(request(kai, `/api/social/me/notifications/${follow.id}/read`, "POST"), testClient()),
      "notification-unread-response",
    );
    assert.equal(one.unread_count, page.items.length - 1);
    assert.equal((await newest(kai)).newest_unread_id, highestId(page.items.filter((item) => item.id !== follow.id).map((item) => item.id)));
    // Repeating is harmless.
    await json(await routes.markRead.POST(request(kai, `/api/social/me/notifications/${follow.id}/read`, "POST"), testClient()), "notification-unread-response");
    const bobsId = (await admin.query<{ id: string }>("SELECT notification_id::text AS id FROM social_notifications WHERE account_id = $1 LIMIT 1", [ACCOUNTS.bob.id])).rows[0]!.id;
    await json(await routes.markRead.POST(request(kai, `/api/social/me/notifications/${bobsId}/read`, "POST"), testClient()), "error", 404);
    await json(await routes.markRead.POST(request(kai, "/api/social/me/notifications/x1/read", "POST"), testClient()), "error", 404);
    assert.equal(await unread(ACCOUNTS.bob.did), 2, "Bob's stay unread");
    const reread = await json<SocialNotificationPage>(await routes.page.GET(request(kai, "/api/social/me/notifications"), testClient()), "notification-page");
    assert.equal(reread.items.find((item) => item.id === follow.id)?.read, true);
    // A backdated notification inserted after the page read stays unread.
    const late = await admin.query<{ id: string }>(
      `INSERT INTO social_notifications (account_id, kind, source_key, presale_id, occurred_at_ms)
       VALUES ($1, 'funded', 'funded:late', $2, $3) RETURNING notification_id::text AS id`,
      [ACCOUNTS.kai.id, P3, NOW - 10 * DAY],
    );
    const through = reread.items.map(({ id }) => BigInt(id)).reduce((highest, id) => id > highest ? id : highest, 0n);
    const markSeen = new Request(`${ORIGIN}/api/social/me/notifications/read`, {
      method: "POST",
      headers: { authorization: `Bearer ${token(kai)}`, "content-type": "application/json" },
      body: JSON.stringify({ through: String(through) }),
    });
    const bounded = await json<{ unread_count: number }>(await routes.readAll.POST(markSeen, testClient()), "notification-unread-response");
    assert.equal(bounded.unread_count, 1);
    assert.deepEqual(await newest(kai), { unread_count: 1, newest_unread_id: late.rows[0]!.id }, "a backdated alert still has the newest ID");
    assert.equal(await unread(ACCOUNTS.bob.did), 2);
    const withLate = await json<SocialNotificationPage>(await routes.page.GET(request(kai, "/api/social/me/notifications"), testClient()), "notification-page");
    assert.deepEqual(withLate.items.filter((item) => !item.read).map((item) => item.id), [late.rows[0]!.id]);
    const legacy = new Request(request(kai, "/api/social/me/notifications/read", "POST"), {
      body: "{}\n", headers: { authorization: `Bearer ${token(kai)}`, "content-type": "application/json" },
    });
    const all = await json<{ unread_count: number }>(await routes.readAll.POST(legacy, testClient()), "notification-unread-response");
    assert.equal(all.unread_count, 0);
    assert.deepEqual(await newest(kai), { unread_count: 0, newest_unread_id: null });

    // Going private hides the actor's notifications everywhere, old ones too.
    await admin.query("DELETE FROM social_notifications WHERE source_key = 'funded:late'");
    await admin.query("DELETE FROM social_notification_reads WHERE account_id = $1", [ACCOUNTS.kai.id]);
    await admin.query("UPDATE social_notifications SET read_at = NULL WHERE account_id = $1", [ACCOUNTS.kai.id]);
    await admin.query("UPDATE social_accounts SET privacy = 'private', sharing_since = NULL WHERE account_id = $1", [ACCOUNTS.mira.id]);
    const afterPrivate = await json<SocialNotificationPage>(await routes.page.GET(request(kai, "/api/social/me/notifications"), testClient()), "notification-page");
    assert.equal(afterPrivate.items.some((item) => item.kind === "follow"), false);
    assert.equal(afterPrivate.unread_count, page.items.length - 1);
    assert.deepEqual(await newest(kai), { unread_count: page.items.length - 1, newest_unread_id: highestId(afterPrivate.items.map((item) => item.id)) }, "a hidden actor's alert is never the newest");

    // Signed out, or without an account.
    await json(await routes.unread.GET(request(null, "/api/social/me/notifications/unread"), testClient()), "error", 401);
    await json(await routes.unread.GET(request("did:privy:notify-nobody", "/api/social/me/notifications/unread"), testClient()), "error", 409);
    // A body on a mark-read is refused.
    const withBody = new Request(`${ORIGIN}/api/social/me/notifications/read`, {
      method: "POST",
      headers: { authorization: `Bearer ${token(kai)}`, "content-type": "application/json" },
      body: JSON.stringify({ all: true }),
    });
    await json(await routes.readAll.POST(withBody, testClient()), "error", 400);
  }));

/**
 * T-043 hidden sales: `EXCLUDED` is one of T-043's real-SUI test sales,
 * which blast-infra leaves out of every presale view (no `presales`,
 * lifecycle, position or vesting row here) but keeps in
 * `chain_read_v1.activity`; `INCOMPLETE` is in `presales` with no coin
 * metadata, so not in `SHOWN_PRESALES`.
 */
const EXCLUDED = hex("5650e2");
const INCOMPLETE = hex("1c0e");

test("T-043 hidden sales: a hidden sale's commit notifies no follower; the page and the count leave out any row of a sale not shown", { skip }, () =>
  withDatabase(async ({ admin, routes, worker }) => {
    await seedChainRead(admin, {
      presales: [presale(INCOMPLETE, "Incomplete", "INC", { sale_symbol: null, sale_name: null, sale_icon_url: null, sale_decimals: null })],
    });
    const w = worker();
    await w.runPass();
    // Mira, whom Kai follows, commits to both hidden sales (big, so a follow line would read "$2,000"), and
    // Bob takes each to 10 backers and past 80%; then a shown sale's commit, which is still notified.
    const hidden = [
      commit(1_001, ACCOUNTS.mira.wallet, { presale_id: EXCLUDED, usd_value: "2000", quote_amount: "2000000000" }),
      commit(1_002, ACCOUNTS.mira.wallet, { presale_id: INCOMPLETE }),
      commit(1_003, ACCOUNTS.bob.wallet, { presale_id: EXCLUDED, participants_after: 10, total_commitments_after: "850000000" }),
      commit(1_004, ACCOUNTS.bob.wallet, { presale_id: INCOMPLETE, participants_after: 10, total_commitments_after: "850000000" }),
    ];
    const shown = commit(1_005, ACCOUNTS.mira.wallet);
    await seedChainRead(admin, { activity: [...hidden, shown] });
    await admin.query(advanceWatermark(1_050, 0, "presale"));
    // Passes of two commits each; a pass of hidden commits only writes nothing, so `drain` would stop early.
    for (let n = 0; n < 4; n += 1) assert.equal((await w.runPass()).outcome, "ok");
    const cursor = (await admin.query<{ value: { c: number } }>("SELECT value FROM social_worker_state WHERE name = 'notify-activity'")).rows[0]!.value;
    assert.equal(cursor.c, 1_050, "the step read every commit up to the watermark");
    await w.release();
    const activityKeys = keysOf(await stored(admin)).filter((key) => /\|(follow|fill):/.test(key));
    assert.deepEqual(activityKeys, [`kai|follow:${activityId(shown)}`]);

    // Rows written before the generator stopped (or before a sale was hidden): never on the page or in the count.
    const kai = ACCOUNTS.kai.did;
    const read = async () => {
      const page = await json<SocialNotificationPage>(await routes.page.GET(request(kai, "/api/social/me/notifications"), testClient()), "notification-page");
      const walked: string[] = [];
      let cursor: string | null = null;
      do {
        const query: string = cursor ? `?limit=1&cursor=${encodeURIComponent(cursor)}` : "?limit=1";
        const part: SocialNotificationPage = await json<SocialNotificationPage>(await routes.page.GET(request(kai, `/api/social/me/notifications${query}`), testClient()), "notification-page");
        walked.push(...part.items.map((item: SocialNotification) => item.id));
        cursor = part.next_cursor;
      } while (cursor);
      return { ids: page.items.map((item) => item.id), walked, unread: page.unread_count, text: JSON.stringify(page) };
    };
    const before = await read();
    assert.ok(before.ids.length >= 2);
    await admin.query(
      `INSERT INTO social_notifications (account_id, kind, source_key, presale_id, actor_account_id, entry_id, occurred_at_ms, data) VALUES
         ($1, 'follow', 'follow:1001:99:0:0', $2, $3, 'a:1001:99:0:0', $4, '{"usd":"2000"}'),
         ($1, 'funded', $5, $6, NULL, NULL, $7, '{}'),
         ($1, 'fill', $8, $2, NULL, NULL, $7, '{"m":"participants","v":10}')`,
      [ACCOUNTS.kai.id, EXCLUDED, ACCOUNTS.mira.id, NOW, `funded:${INCOMPLETE}`, INCOMPLETE, NOW - 1_000, `fill:${EXCLUDED}:participants:10`],
    );
    const after = await read();
    assert.deepEqual(after.ids, before.ids);
    assert.deepEqual(after.walked, before.walked, "a page of one is never empty because of them");
    assert.equal(after.unread, before.unread);
    assert.doesNotMatch(after.text, /5650e2|"A presale"|1c0e/);
  }));

const P5 = hex("3a1");
const P6 = hex("3a2");
const P7 = hex("3a3");

test("call_up: a sale's callers hear the highest threshold its coin crosses over the entry, each once, by preference", { skip }, () =>
  withDatabase(async ({ admin, routes, worker }) => {
    const coin = `${P5}::coin::WAL`;
    const claimed = (wallet: string, commitment: string, tokens: string, presale_id = P5) => ({
      presale_id, wallet, commitment, last_commit_ms: NOW - 3 * DAY, claim_digest: `Claim${wallet.slice(-2)}${presale_id.slice(-1)}`.padEnd(44, "1"),
      claimed_tokens: tokens, claimed_quote_refund: "0", claimed_ms: NOW - DAY,
    });
    // P6 migrated two days ago, but its price is stale when the step first runs; P7 migrates after that.
    const coin6 = `${P6}::coin::OLD`;
    const coin7 = `${P7}::coin::NEW`;
    await seedChainRead(admin, {
      presales: [presale(P6, "Oldie", "OLD", { lifecycle: "migrated", end_ms: NOW - 3 * DAY }), presale(P7, "Newbie", "NEW", { lifecycle: "migrated", end_ms: NOW - DAY })],
      presale_lifecycle: [{ presale_id: P6, state: "migrated", digest: "MigrOld".padEnd(44, "1"), timestamp_ms: NOW - 2 * DAY, checkpoint: 800 }],
      presale_positions: [claimed(ACCOUNTS.kai.wallet, "100000000", "400000000000", P6), claimed(ACCOUNTS.kai.wallet, "100000000", "400000000000", P7)],
      activity: [P6, P7].map((presale_id) => commit(905, ACCOUNTS.kai.wallet, { presale_id, timestamp_ms: NOW - 3 * DAY })),
      prices: [
        { coin_type: coin6, usd_price: "1.00", as_of_ms: Date.now() - 30 * 60_000, source: "pool" },
        { coin_type: coin7, usd_price: "0.30", as_of_ms: Date.now() - 30 * 60_000, source: "pool" },
      ],
    });
    // 100 USDC bought 400 WAL: the entry is $0.25 for every backer (claims are pro rata).
    await seedChainRead(admin, {
      presales: [presale(P5, "Walrus", "WAL", { lifecycle: "migrated", end_ms: NOW - 2 * DAY })],
      presale_positions: [
        claimed(ACCOUNTS.kai.wallet, "100000000", "400000000000"),
        claimed(ACCOUNTS.bob.wallet, "50000000", "200000000000"),
        claimed(ACCOUNTS.nadia.wallet, "20000000", "80000000000"),
        claimed(ACCOUNTS.hidden.wallet, "20000000", "80000000000"),
      ],
      activity: [ACCOUNTS.kai, ACCOUNTS.bob, ACCOUNTS.nadia, ACCOUNTS.hidden].map((account, index) =>
        commit(900 + index, account.wallet, { presale_id: P5, timestamp_ms: NOW - 3 * DAY })),
      prices: [{ coin_type: coin, usd_price: "0.30", as_of_ms: Date.now(), source: "pool" }],
    });
    // Nadia turned the switch off; the private account is never a caller.
    await admin.query("UPDATE social_notification_preferences SET call_moves = false WHERE account_id = $1", [ACCOUNTS.nadia.id]);
    const price = async (usd: string, ageMs = 0) => {
      await admin.query("UPDATE blast_infra_fixture.prices SET usd_price = $2, as_of_ms = $3 WHERE coin_type = $1", [coin, usd, Date.now() - ageMs]);
      await admin.query(advanceWatermark(1_050));
    };
    const calls = async () => keysOf((await stored(admin)).filter((row) => row.kind === "call_up"));
    await admin.query(advanceWatermark(1_050));
    const w = worker();

    // The first pass records where the sale stands (+20%): nothing before the worker ran is notified.
    await w.runPass();
    assert.deepEqual(await calls(), []);

    // $0.80 is +220%: past +50%, +100% and +200% at once, so only +200% is sent.
    await price("0.80");
    await drain(w);
    assert.deepEqual(await calls(), [`bob|call_up:${P5}:200`, `kai|call_up:${P5}:200`]);
    assert.deepEqual((await stored(admin)).find((row) => row.source_key === `call_up:${P5}:200`)!.data, { t: 200, e: "0.25", p: "0.8" });

    // A fall and a rise past +100% again send nothing lower; a stale $3 sends nothing at all.
    await price("0.40");
    await drain(w);
    await price("0.60");
    await drain(w);
    await price("3", 10 * 60_000);
    await drain(w);
    assert.equal((await calls()).length, 2, JSON.stringify(await calls()));

    // $1.60 is +540%: +500% is new.
    await price("1.60");
    await drain(w);
    assert.deepEqual((await calls()).filter((key) => key.includes(P5)), [`bob|call_up:${P5}:200`, `bob|call_up:${P5}:500`, `kai|call_up:${P5}:200`, `kai|call_up:${P5}:500`]);

    // First seen fresh at +300%: P6 migrated before the step's first pass, so its rise is recorded, not announced.
    const priceOf = async (coinType: string, usd: string) => {
      await admin.query("UPDATE blast_infra_fixture.prices SET usd_price = $2, as_of_ms = $3 WHERE coin_type = $1", [coinType, usd, Date.now()]);
      await admin.query(advanceWatermark(1_050));
    };
    await priceOf(coin6, "1.00");
    await drain(w);
    assert.ok(!(await calls()).some((key) => key.includes(P6)));
    await priceOf(coin6, "1.60");
    await drain(w);
    assert.ok((await calls()).includes(`kai|call_up:${P6}:500`), "a later rise past a new threshold is sent");
    // P7 migrates after the first pass and is first seen at +120%: that rise is new, so +100% is sent.
    await seedChainRead(admin, { presale_lifecycle: [{ presale_id: P7, state: "migrated", digest: "MigrNew".padEnd(44, "1"), timestamp_ms: Date.now(), checkpoint: 1_040 }] });
    await priceOf(coin7, "0.55");
    await drain(w);
    assert.ok((await calls()).includes(`kai|call_up:${P7}:100`));
    assert.ok(!(await calls()).some((key) => key.includes(`${P6}:200`) || key.includes(`${P7}:50`)));
    const cursor = (await admin.query<{ value: { since_ms: number; top: Record<string, number> } }>("SELECT value FROM social_worker_state WHERE name = 'notify-calls'")).rows[0]!.value;
    assert.deepEqual([cursor.top[P5], cursor.top[P6], cursor.top[P7]], [500, 500, 100]);

    // A restarted worker, and the rows' retention, repeat none: the cursor keeps each sale's highest threshold.
    await w.release();
    await admin.query("DELETE FROM social_notifications WHERE kind = 'call_up' AND source_key LIKE '%:200'");
    const restarted = worker();
    await drain(restarted);
    assert.equal((await calls()).filter((key) => key.includes(P5)).length, 2);
    await restarted.release();

    const page = await json<SocialNotificationPage>(await routes.page.GET(request(ACCOUNTS.kai.did, "/api/social/me/notifications"), testClient()), "notification-page");
    const up = page.items.find((item) => item.kind === "call_up" && item.presale?.presale_id === P5)!;
    assert.equal(up.title, "WAL is up 500% since your call");
    assert.equal(up.sub, "Called at $0.2500 · now $1.60");
    assert.equal(up.href, `/presale/${P5}`);
    assert.equal(up.actor, null);
  }));
