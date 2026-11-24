import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import type { Pool } from "pg";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import {
  CHAIN_READ_ROWS,
  FIXTURE_PRESALE_ID,
  FIXTURE_QUOTE_TYPE,
  FIXTURE_SALE_COIN_TYPE,
  seedChainRead,
  type ChainActivityRow,
} from "../../../../../core/test/fixtures/modules/database/chain-read-rows.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";
import { autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { activityEntryId } from "@blast/core/modules/social/contracts/feed-entries.ts";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type SocialSettingsResponse,
} from "@blast/core/modules/social/contracts/settings.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import {
  accountsWantingNotification,
  readNotificationPreferences,
} from "@blast/server/modules/social/notification-preferences/index.ts";
import { personEntriesOf } from "@blast/server/modules/social/read-model/index.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { createSocialMeRoute } from "@blast/server/modules/social/accounts/me-route.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import { createSocialSettingsRoute } from "@blast/server/modules/social/accounts/settings-route.ts";
import { uuid } from "../../../../../core/test/kit.ts";

/**
 * Social-feed T-016 (AC-024, AC-025, AC-027, AC-093, AC-126): `PUT
 * /api/social/me/settings` over migrations 0054/0055 as the web runtime role
 * `blast_web`, with a real Privy token verifier over a fixture ES256 key and
 * the Postgres rate limiter. Naming is checked through the T-004 read model
 * against fixture `chain_read_v1` activity, never re-derived here.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "social-settings-app";
const NOW = Math.floor(Date.now() / 1_000);
const PEPPER = "social-settings-fixture-pepper-0123456789";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const verificationKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
const validator = createSocialValidator();
const POOL_SETTINGS = {
  connectionTimeoutMs: 5_000,
  idleInTransactionMs: 5_000,
  idleTimeoutMs: 1_000,
  lockTimeoutMs: 2_000,
  max: 8,
  statementTimeoutMs: 5_000,
};
const PAGE = { limit: 200 } as const;

const wallet = (tag: string) => `0x${tag.padStart(64, "0")}`;

/** Onboarded and sharing since 2026-03-01; un-onboarded; onboarded (for the rate limit); no account. */
const ACCOUNTS = {
  onboarded: { id: uuid(0xa1), did: "did:privy:settings-onboarded", callsign: "set_onboarded", wallet: wallet("a1") },
  fresh: { id: uuid(0xa2), did: "did:privy:settings-fresh", callsign: "set_fresh", wallet: wallet("a2") },
  busy: { id: uuid(0xa3), did: "did:privy:settings-busy", callsign: "set_busy", wallet: wallet("a3") },
} as const;
const NOBODY_DID = "did:privy:settings-nobody";
const SHARING_SINCE = "2026-03-01T00:00:00.000Z";
const LINKED_AT = "2026-02-01T00:00:00Z";

function token(did: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: NOW + 3_600, iat: NOW - 60, iss: "privy.io", sid: "s-1", sub: did });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

function get(did: string | null): Request {
  return new Request(`${ORIGIN}/api/social/me/settings`, { headers: did ? { authorization: `Bearer ${token(did)}` } : {} });
}

function put(did: string | null, body: unknown, contentType = "application/json"): Request {
  const headers: Record<string, string> = { "content-type": contentType };
  if (did) headers.authorization = `Bearer ${token(did)}`;
  return new Request(`${ORIGIN}/api/social/me/settings`, {
    method: "PUT",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

let slot = 0;
function commit(timestampMs: number, actor: string): ChainActivityRow {
  slot += 1;
  return {
    checkpoint: 7_000 + slot,
    tx_slot: slot,
    event_slot: 0,
    part: 0,
    timestamp_ms: timestampMs,
    digest: `Sx${slot}`.padEnd(44, "1"),
    kind: "presale_commit",
    product: "presale",
    actor,
    tx_sender: actor,
    presale_id: FIXTURE_PRESALE_ID,
    coin_type: FIXTURE_SALE_COIN_TYPE,
    quote_type: FIXTURE_QUOTE_TYPE,
    quote_amount: "1000000000",
    coin_amount: null,
    quote_refund: null,
    usd_value: "10",
    usd_price_as_of_ms: timestampMs - 1_000,
    venue: null,
    participants_after: null,
    total_commitments_after: null,
  };
}

const entryId = (row: ChainActivityRow) => activityEntryId(`${row.checkpoint}:${row.tx_slot}:${row.event_slot}:${row.part}`);

type Fixture = Readonly<{
  admin: Pool;
  /** The test's own database. */
  url: string;
  web: Pool;
  db: ReadableDatabase;
  route: ReturnType<typeof createSocialSettingsRoute>;
  me: ReturnType<typeof createSocialMeRoute>;
}>;

async function withDatabase(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const database = await freshTestDatabase();
  const { url } = database;
  const admin = createPool(url, { max: 4 });
  const web = createRuntimePool(urlAs(url, "blast_web"), POOL_SETTINGS, "social-settings-test");
  try {
    // The commits' sale is one the web shows: the read model keeps no entry of a hidden sale (T-043, 2026-10-05).
    await seedChainRead(admin, { presales: CHAIN_READ_ROWS.presales });
    for (const [name, account] of Object.entries(ACCOUNTS)) {
      const onboarded = name !== "fresh";
      await admin.query(
        `INSERT INTO social_accounts (account_id, privy_did, callsign, onboarding_shown_at, onboarded_at, privacy, sharing_since)
         VALUES ($1, $2, $3, now(), $4::timestamptz, 'public', $4::timestamptz)`,
        [account.id, account.did, account.callsign, onboarded ? SHARING_SINCE : null],
      );
      await admin.query(
        "INSERT INTO social_account_wallets (address, account_id, kind, verified_at) VALUES ($1, $2, 'external', $3)",
        [account.wallet, account.id, LINKED_AT],
      );
    }
    const accounts = new PostgresSocialAccounts(() => web);
    const kit = createSocialRouteKit({
      tradingVisible: () => true,
      expectedOrigin: ORIGIN,
      verifyAccessToken: createPrivyTokenVerifier({ appId: APP_ID, verificationKey }),
      limiter: new PostgresRateLimitEnforcer({ pool: web, subjectPepper: PEPPER }),
      accounts,
      primary: () => web,
    });
    await run({
      admin,
      url,
      web,
      db: autocommitReader(web, "social"),
      route: createSocialSettingsRoute({ kit }),
      me: createSocialMeRoute({ kit, accounts }),
    });
  } finally {
    await web.end();
    await admin.end();
    await database.drop();
  }
}

/** A 200 settings body, checked against the published schema and the private, no-store headers. */
async function settingsBody(response: Response): Promise<SocialSettingsResponse> {
  const body: unknown = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(validator.validate("settings-response", body).errors, []);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.ok(response.headers.get("x-request-id"));
  return body as SocialSettingsResponse;
}

/** A settings body with the settings UI-07 (and R3-12's sound switch, not chosen: OA-33) added at their defaults. */
function withDefaults(core: Pick<SocialSettingsResponse, "privacy" | "sharing_since_ms">): SocialSettingsResponse {
  return { ...core, commit_too_coin_type: null, public_portfolio: false, explorer: "suiscan", sound: null, blast_mode_confirm_actions: false, notifications: DEFAULT_NOTIFICATION_PREFERENCES };
}

async function refusal(response: Response, status: number, code: string): Promise<void> {
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(body.error.code, code);
  assert.deepEqual(validator.validate("error", body).errors, []);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.ok(response.headers.get("x-request-id"));
}

type StoredRow = { privacy: string; sharing_since: string | null; explorer: string };

async function stored(admin: Pool, accountId: string): Promise<StoredRow> {
  const result = await admin.query<StoredRow>(
    `SELECT privacy, to_char(sharing_since AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS sharing_since, explorer
     FROM social_accounts WHERE account_id = $1`,
    [accountId],
  );
  return result.rows[0]!;
}

async function namedIds(db: ReadableDatabase, accountId: string): Promise<string[]> {
  return (await personEntriesOf(db, [accountId], PAGE)).map((entry) => entry.entryId).sort();
}

test("T-016-AC-1, AC-2 (AC-024, AC-025): going private unnames everything; going public names only later actions", { skip }, () =>
  withDatabase(async ({ admin, db, route, me }) => {
    const { id, did } = ACCOUNTS.onboarded;
    const w = ACCOUNTS.onboarded.wallet;
    const sharedEarlier = [commit(Date.parse("2026-03-02T00:00:00Z"), w), commit(Date.parse("2026-04-01T00:00:00Z"), w)];
    await seedChainRead(admin, { activity: sharedEarlier });
    assert.deepEqual(await namedIds(db, id), sharedEarlier.map(entryId).sort());

    // AC-1: private sets privacy and clears sharing_since; the next uncached read names nothing.
    const privateBody = await settingsBody(await route.PUT(put(did, { private: true }), testClient()));
    assert.deepEqual(privateBody, withDefaults({ privacy: "private", sharing_since_ms: null }));
    assert.deepEqual(await stored(admin, id), { privacy: "private", sharing_since: null, explorer: "suiscan" });
    assert.deepEqual(await namedIds(db, id), []);
    // `me` reads the same state.
    const meAccount = ((await (await me.GET(new Request(`${ORIGIN}/api/social/me`, {
      headers: { authorization: `Bearer ${token(did)}` },
    }), testClient())).json()) as { account: { privacy: string; sharing_since_ms: number | null } }).account;
    assert.equal(meAccount.privacy, "private");
    assert.equal(meAccount.sharing_since_ms, null);

    // An action while private.
    const whilePrivate = commit(Date.now() - 1_000, w);
    await seedChainRead(admin, { activity: [whilePrivate] });

    // AC-2: public again starts sharing at the server's time.
    const before = Date.now();
    const publicBody = await settingsBody(await route.PUT(put(did, { private: false }), testClient()));
    const after = Date.now();
    assert.equal(publicBody.privacy, "public");
    assert.ok(publicBody.sharing_since_ms !== null);
    assert.ok(publicBody.sharing_since_ms >= before - 1_000 && publicBody.sharing_since_ms <= after + 1_000);
    const since = publicBody.sharing_since_ms;
    const sinceStored = (await stored(admin, id)).sharing_since;
    assert.ok(sinceStored);

    // A commit timed just before the new sharing_since stays unnamed; a later one is named.
    const justBefore = commit(since - 1, w);
    const later = commit(since + 1, w);
    await seedChainRead(admin, { activity: [justBefore, later] });
    assert.deepEqual(await namedIds(db, id), [entryId(later)]);

    // Re-sending private:false, or changing only another setting, leaves sharing_since unchanged.
    const again = await settingsBody(await route.PUT(put(did, { private: false }), testClient()));
    assert.equal(again.sharing_since_ms, since);
    const explorerOnly = await settingsBody(await route.PUT(put(did, { explorer: "suivision" }), testClient()));
    assert.deepEqual(explorerOnly, { ...withDefaults({ privacy: "public", sharing_since_ms: since }), explorer: "suivision" });
    const both = await settingsBody(await route.PUT(put(did, { private: false, explorer: "suiscan" }), testClient()));
    assert.deepEqual(both, withDefaults({ privacy: "public", sharing_since_ms: since }));
    assert.deepEqual(await stored(admin, id), { privacy: "public", sharing_since: sinceStored, explorer: "suiscan" });
    assert.deepEqual(await namedIds(db, id), [entryId(later)]);

    // An empty body changes nothing and answers the stored settings.
    assert.deepEqual(await settingsBody(await route.PUT(put(did, {}), testClient())), both);

    // A public account that never shared (sharing_since null) stays unshared on private:false.
    await admin.query("UPDATE social_accounts SET sharing_since = NULL WHERE account_id = $1", [ACCOUNTS.busy.id]);
    const unshared = await settingsBody(await route.PUT(put(ACCOUNTS.busy.did, { private: false }), testClient()));
    assert.deepEqual(unshared, withDefaults({ privacy: "public", sharing_since_ms: unshared.sharing_since_ms }));
  }));

test("T-016-AC-3 (AC-027, AC-126): existing callsigns can change privacy without onboarding; the 31st update in ten minutes is rate limited", { skip }, () =>
  withDatabase(async ({ admin, route }) => {
    const fresh = ACCOUNTS.fresh;
    assert.equal((await settingsBody(await route.PUT(put(fresh.did, { private: true }), testClient()))).privacy, "private");
    const publicSettings = await settingsBody(await route.PUT(put(fresh.did, { private: false }), testClient()));
    assert.equal(publicSettings.privacy, "public");
    assert.ok(publicSettings.sharing_since_ms !== null);
    assert.equal((await settingsBody(await route.PUT(put(fresh.did, { private: true, explorer: "suivision" }), testClient()))).explorer, "suivision");

    // AC-126: social_account_update allows 30 per 10 minutes per account; refusals count too.
    const busy = ACCOUNTS.busy.did;
    for (let n = 1; n <= 30; n += 1) {
      const response = await route.PUT(put(busy, { explorer: n % 2 === 0 ? "suivision" : "suiscan" }), testClient());
      assert.equal(response.status, 200, `request ${n}`);
    }
    const limited = await route.PUT(put(busy, { explorer: "suiscan" }), testClient());
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
    await refusal(limited, 429, "rate_limited");
    assert.equal((await stored(admin, ACCOUNTS.busy.id)).explorer, "suivision");
    // Per account: another account is not limited.
    assert.equal((await route.PUT(put(ACCOUNTS.onboarded.did, {}), testClient())).status, 200);
  }));

test("the hold's pay coin is a canonical coin type, or null for each sale's own coin", { skip }, () =>
  withDatabase(async ({ route }) => {
    const { did } = ACCOUNTS.onboarded;
    const lofi = `0x${"a".repeat(64)}::lofi::LOFI`;
    assert.equal((await settingsBody(await route.PUT(put(did, { commit_too_coin_type: lofi }), testClient()))).commit_too_coin_type, lofi);
    // Another field leaves it alone; null resets it to the sale's own coin.
    assert.equal((await settingsBody(await route.PUT(put(did, { explorer: "suivision" }), testClient()))).commit_too_coin_type, lofi);
    for (const bad of ["0x2::sui::SUI", "LOFI", 5, `${lofi}<${"x".repeat(600)}>`]) {
      await refusal(await route.PUT(put(did, { commit_too_coin_type: bad }), testClient()), 400, "invalid_request");
    }
    assert.equal((await settingsBody(await route.PUT(put(did, { commit_too_coin_type: null }), testClient()))).commit_too_coin_type, null);
  }));

test("T-016: closed body, sign-in and account are required", { skip }, () =>
  withDatabase(async ({ admin, route }) => {
    const { id, did } = ACCOUNTS.onboarded;
    const before = await stored(admin, id);
    await refusal(await route.PUT(put(did, { private: "yes" }), testClient()), 400, "invalid_request");
    await refusal(await route.PUT(put(did, { private: null }), testClient()), 400, "invalid_request");
    await refusal(await route.PUT(put(did, { private: true, privacy: "private" }), testClient()), 400, "invalid_request");
    // AC-093: the removed Default amount is an unknown key now.
    await refusal(await route.PUT(put(did, { commit_too_amount_usd: "50" }), testClient()), 400, "invalid_request");
    await refusal(await route.PUT(put(did, [true]), testClient()), 400, "invalid_request");
    await refusal(await route.PUT(put(did, "{not json"), testClient()), 400, "invalid_request");
    await refusal(await route.PUT(put(did, { private: true }, "text/plain"), testClient()), 400, "invalid_request");
    await refusal(await route.PUT(put(did, JSON.stringify({ explorer: "1".repeat(5_000) })), testClient()), 413, "body_too_large");
    await refusal(await route.PUT(put(null, { private: true }), testClient()), 401, "unauthorized");
    await refusal(await route.PUT(put(NOBODY_DID, { private: true }), testClient()), 409, "account_required");
    assert.deepEqual(await stored(admin, id), before);
  }));

type StoredExtras = { portfolio_public: boolean; explorer: string; preference_rows: number };

async function storedExtras(admin: Pool, accountId: string): Promise<StoredExtras> {
  const result = await admin.query<StoredExtras>(
    `SELECT portfolio_public, explorer,
       (SELECT count(*)::int FROM social_notification_preferences p WHERE p.account_id = a.account_id) AS preference_rows
     FROM social_accounts a WHERE account_id = $1`,
    [accountId],
  );
  return result.rows[0]!;
}

test("UI-07 (OA-10, OA-11): GET reads every setting; PUT stores public portfolio, explorer and any notification switches", { skip }, () =>
  withDatabase(async ({ admin, url, route, web }) => {
    const { id, did } = ACCOUNTS.onboarded;
    // Defaults: portfolio private, Suiscan, every switch on, and no preferences row yet.
    const initial = await settingsBody(await route.GET(get(did), testClient()));
    assert.deepEqual(initial, withDefaults({ privacy: "public", sharing_since_ms: Date.parse(SHARING_SINCE) }));
    assert.deepEqual(await storedExtras(admin, id), { portfolio_public: false, explorer: "suiscan", preference_rows: 0 });

    const opened = await settingsBody(await route.PUT(put(did, { public_portfolio: true, explorer: "suivision" }), testClient()));
    assert.equal(opened.public_portfolio, true);
    assert.equal(opened.explorer, "suivision");
    assert.deepEqual(opened.notifications, DEFAULT_NOTIFICATION_PREFERENCES);
    assert.equal(opened.sharing_since_ms, Date.parse(SHARING_SINCE), "opening the portfolio does not touch sharing");

    // One switch changes; the other six keep their value (on), and the row appears.
    const quiet = await settingsBody(await route.PUT(put(did, { notifications: { almost_full: false } }), testClient()));
    assert.deepEqual(quiet.notifications, { ...DEFAULT_NOTIFICATION_PREFERENCES, almost_full: false });
    const more = await settingsBody(await route.PUT(put(did, { notifications: { unlocks: false, people_you_follow: false } }), testClient()));
    assert.deepEqual(more.notifications, { ...DEFAULT_NOTIFICATION_PREFERENCES, almost_full: false, unlocks: false, people_you_follow: false });
    // Repeating a change is a no-op; turning one back on works.
    assert.deepEqual((await settingsBody(await route.PUT(put(did, { notifications: { unlocks: false } }), testClient()))).notifications, more.notifications);
    const back = await settingsBody(await route.PUT(put(did, { notifications: { unlocks: true }, explorer: "suiscan" }), testClient()));
    assert.deepEqual(back.notifications, { ...DEFAULT_NOTIFICATION_PREFERENCES, almost_full: false, people_you_follow: false });
    assert.equal(back.explorer, "suiscan");
    assert.deepEqual(await storedExtras(admin, id), { portfolio_public: true, explorer: "suiscan", preference_rows: 1 });

    // GET reads back exactly what the last PUT answered; an empty notifications object changes nothing.
    assert.deepEqual(await settingsBody(await route.GET(get(did), testClient())), back);
    assert.deepEqual(await settingsBody(await route.PUT(put(did, { notifications: {} }), testClient())), back);

    // The notification system's read: batch, defaults for an account without a row, filter by switch.
    const reader = autocommitReader(web, "social");
    const both = await readNotificationPreferences(reader, [id, ACCOUNTS.busy.id, id]);
    assert.equal(both.size, 2);
    assert.deepEqual(both.get(ACCOUNTS.busy.id), DEFAULT_NOTIFICATION_PREFERENCES);
    assert.deepEqual(both.get(id), back.notifications);
    assert.deepEqual(await accountsWantingNotification(reader, "almost_full", [id, ACCOUNTS.busy.id]), [ACCOUNTS.busy.id]);
    assert.deepEqual(await accountsWantingNotification(reader, "funded", [ACCOUNTS.busy.id, id, id]), [ACCOUNTS.busy.id, id]);
    assert.deepEqual(await readNotificationPreferences(reader, []), new Map());
    // The watcher, which will send notifications, may read them and write nothing.
    const watcher = createRuntimePool(urlAs(url, "blast_watcher"), POOL_SETTINGS, "social-settings-watcher");
    try {
      assert.deepEqual(
        (await readNotificationPreferences(autocommitReader(watcher, "social"), [id])).get(id),
        back.notifications,
      );
      await assert.rejects(
        watcher.query("UPDATE social_notification_preferences SET funded = false WHERE account_id = $1", [id]),
        { code: "42501" },
      );
    } finally {
      await watcher.end();
    }
  }));

test("UI-07: existing callsigns can change portfolio visibility without onboarding; malformed settings are invalid_request", { skip }, () =>
  withDatabase(async ({ admin, route }) => {
    const fresh = ACCOUNTS.fresh;
    const early = await settingsBody(await route.PUT(put(fresh.did, { public_portfolio: true, explorer: "suivision", notifications: { funded: false } }), testClient()));
    assert.equal(early.public_portfolio, true);
    assert.equal(early.explorer, "suivision");
    assert.equal(early.notifications.funded, false);
    await settingsBody(await route.PUT(put(fresh.did, { public_portfolio: false }), testClient()));
    assert.deepEqual(await storedExtras(admin, fresh.id), { portfolio_public: false, explorer: "suivision", preference_rows: 1 });

    const { id, did } = ACCOUNTS.onboarded;
    const before = await storedExtras(admin, id);
    for (const body of [
      { public_portfolio: "yes" },
      { public_portfolio: null },
      { explorer: "suivision.xyz" },
      { explorer: null },
      { notifications: { funded: "off" } },
      { notifications: { sales: false } },
      { notifications: [true] },
      { notifications: null },
      { notifications: { funded: false }, celebrations: true },
    ]) {
      await refusal(await route.PUT(put(did, body), testClient()), 400, "invalid_request");
    }
    assert.deepEqual(await storedExtras(admin, id), before);
    // The published request schema agrees with the route on each shape.
    assert.equal(validator.validate("settings-request", { public_portfolio: true, explorer: "suiscan", notifications: { opens_soon: false } }).valid, true);
    assert.equal(validator.validate("settings-request", { notifications: { sales: false } }).valid, false);
    assert.equal(validator.validate("settings-request", { explorer: "etherscan" }).valid, false);

    // GET: sign-in and an account are required; it counts in no bucket, answers private, no-store.
    await refusal(await route.GET(get(null), testClient()), 401, "unauthorized");
    await refusal(await route.GET(get(NOBODY_DID), testClient()), 409, "account_required");
    for (let n = 0; n < 35; n += 1) assert.equal((await route.GET(get(did), testClient())).status, 200);
  }));

test("R3-12 with OA-33 (0093, 0099): an account's sound is null until it chooses; a choice is a closed boolean, kept, and never reset to null", { skip }, () =>
  withDatabase(async ({ admin, route }) => {
    const soundOf = async (accountId: string) =>
      (await admin.query<{ sound: boolean | null }>("SELECT sound FROM social_accounts WHERE account_id = $1", [accountId])).rows[0]!.sound;
    const { id, did } = ACCOUNTS.onboarded;
    // No choice yet: NULL on the row, null from GET — sound stays off, as for a visitor; it is not "on".
    assert.equal(await soundOf(id), null);
    const before = await settingsBody(await route.GET(get(did), testClient()));
    assert.equal(before.sound, null);
    // Saving another setting makes no choice for the reader.
    assert.equal((await settingsBody(await route.PUT(put(did, { explorer: "suivision" }), testClient()))).sound, null);
    assert.equal(await soundOf(id), null);

    // The reader turns it on (a switch, or a session handing over this device's choice): stored, read back.
    const on = await settingsBody(await route.PUT(put(did, { sound: true }), testClient()));
    assert.deepEqual(on, { ...before, explorer: "suivision", sound: true });
    assert.equal(await soundOf(id), true);
    assert.deepEqual(await settingsBody(await route.GET(get(did), testClient())), on);
    // Off is a choice too, kept through another field's save; and on again.
    assert.equal((await settingsBody(await route.PUT(put(did, { sound: false }), testClient()))).sound, false);
    assert.equal((await settingsBody(await route.PUT(put(did, { explorer: "suiscan" }), testClient()))).sound, false);
    assert.equal(await soundOf(id), false);
    assert.equal((await settingsBody(await route.PUT(put(did, { sound: true }), testClient()))).sound, true);

    // A device choice is not a privacy choice: accepted before onboarding.
    assert.equal(await soundOf(ACCOUNTS.fresh.id), null);
    assert.equal((await settingsBody(await route.PUT(put(ACCOUNTS.fresh.did, { sound: false }), testClient()))).sound, false);
    assert.equal(await soundOf(id), true, "one account's switch never touches another's");

    // Closed: anything but a boolean is refused — null included, so a choice is never reset to "not chosen".
    for (const body of [{ sound: "on" }, { sound: null }, { sound: 1 }]) {
      await refusal(await route.PUT(put(did, body), testClient()), 400, "invalid_request");
    }
    assert.equal(await soundOf(id), true);
    assert.equal(validator.validate("settings-request", { sound: false }).valid, true);
    assert.equal(validator.validate("settings-request", { sound: null }).valid, false);
    assert.equal(validator.validate("settings-request", { sound: "off" }).valid, false);
    assert.equal(validator.validate("settings-response", { ...before, sound: "off" }).valid, false);
  }));

test("Blast Mode confirmation defaults off, persists per account across readers, and preserves partial settings", { skip }, () =>
  withDatabase(async ({ route, web }) => {
    const did = ACCOUNTS.onboarded.did;
    const initial = await settingsBody(await route.GET(get(did), testClient()));
    assert.equal(initial.blast_mode_confirm_actions, false);
    const enabled = await settingsBody(await route.PUT(put(did, { blast_mode_confirm_actions: true }), testClient()));
    assert.deepEqual(enabled, { ...initial, blast_mode_confirm_actions: true });
    // A second route instance uses the primary, as another tab/device does.
    const secondReader = createSocialSettingsRoute({
      kit: createSocialRouteKit({
        tradingVisible: () => true,
        expectedOrigin: ORIGIN,
        verifyAccessToken: createPrivyTokenVerifier({ appId: APP_ID, verificationKey }),
        limiter: new PostgresRateLimitEnforcer({ pool: web, subjectPepper: PEPPER }),
        accounts: new PostgresSocialAccounts(() => web),
        primary: () => web,
      }),
      database: () => autocommitReader(web, "social"),
    });
    assert.deepEqual(await settingsBody(await secondReader.GET(get(did), testClient())), enabled);
    const partial = await settingsBody(await route.PUT(put(did, { sound: true, notifications: { funded: false } }), testClient()));
    assert.equal(partial.blast_mode_confirm_actions, true);
    assert.equal(partial.sound, true);
    assert.equal(partial.notifications.funded, false);
    assert.equal((await settingsBody(await route.GET(get(ACCOUNTS.fresh.did), testClient()))).blast_mode_confirm_actions, false);
    for (const value of [null, "true", 1, {}, []]) {
      await refusal(await route.PUT(put(did, { blast_mode_confirm_actions: value }), testClient()), 400, "invalid_request");
      assert.equal(validator.validate("settings-request", { blast_mode_confirm_actions: value }).valid, false);
    }
    assert.equal((await settingsBody(await route.GET(get(did), testClient()))).blast_mode_confirm_actions, true);
    const disabled = await settingsBody(await route.PUT(put(did, { blast_mode_confirm_actions: false }), testClient()));
    assert.deepEqual(disabled, { ...partial, blast_mode_confirm_actions: false });
  }));
