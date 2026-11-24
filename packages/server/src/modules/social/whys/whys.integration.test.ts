import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import type { Pool } from "pg";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { seedChainRead } from "../../../../../core/test/fixtures/modules/database/chain-read-rows.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import { createSocialConfigReader } from "@blast/core/modules/social/config/reader.ts";
import { activityEntryId } from "@blast/core/modules/social/contracts/feed-entries.ts";
import type { SocialFeedPage } from "@blast/core/modules/social/contracts/feed.ts";
import { socialItemPath, type SocialItemResponse } from "@blast/core/modules/social/contracts/item-routes.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import {
  socialItemWhyPath,
  socialWhyPath,
  socialWhyReportsPath,
  type SocialWhyCreated,
  type SocialWhyReported,
} from "@blast/core/modules/social/contracts/whys.ts";
import { FEED_STORY_PRESALES, FEED_STORY_QUOTE_TYPE, FEED_STORY_WALLETS, seedFeedStory, type FeedStory } from "../../../../../core/test/fixtures/modules/social/feed/feed-story.ts";
import { createSocialFeedRoute } from "@blast/server/modules/social/feed/route.ts";
import { createSocialPostRoutes } from "@blast/server/modules/social/posts/route.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { createSocialWhyRoutes } from "@blast/server/modules/social/whys/route.ts";
import { WHY_WINDOW_MS } from "@blast/core/modules/social/whys/validate.ts";

/**
 * Social feed T-021 (AC-076 to AC-080, AC-126, AC-130) and T-022 (AC-082,
 * AC-083, AC-126, AC-130): writing a why on one's own named item, the
 * author's delete and another account's report, over a disposable database
 * with the fixture `chain_read_v1` and the feed story. Writes run as
 * `blast_web` on the primary, item and feed reads as `blast_replica`, as in
 * production.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "social-whys-app";
const PEPPER = "social-whys-fixture-pepper-0123456789abcdef";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const validator = createSocialValidator();
const POOL = { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 8, statementTimeoutMs: 10_000 };
const NOW = Date.now();
const HOUR = 3_600_000;
const BLOCKED = "rugpullcoin";

const did = (callsign: string) => `did:privy:feed-story-${callsign}`;

function bearer(subject: string): string {
  const now = Math.floor(Date.now() / 1_000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: now + 3_600, iat: now - 60, iss: "privy.io", sid: "s-1", sub: subject });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `Bearer ${header}.${payload}.${signature.toString("base64url")}`;
}

type Fixture = Readonly<{
  admin: Pool;
  story: FeedStory;
  /** Kai's commit 25 hours before NOW: named, but outside the why window. */
  kaiDayOld: string;
  /** Moves the routes' clock. */
  setNow(ms: number): void;
  why(entryId: string, callsign: string | null, body: unknown, init?: { raw?: string; type?: string; path?: string }): Promise<Response>;
  /** `DELETE /api/social/whys/{why_id}` as `callsign` (T-022). */
  del(whyId: string, callsign: string | null, init?: { path?: string }): Promise<Response>;
  /** `POST /api/social/whys/{why_id}/reports` as `callsign` (T-022). */
  report(whyId: string, callsign: string | null, body: unknown, init?: { raw?: string; type?: string; path?: string }): Promise<Response>;
  item(entryId: string): Promise<SocialItemResponse>;
  feed(): Promise<SocialFeedPage>;
}>;

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const database = await freshTestDatabase();
  const { url } = database;
  const admin = createPool(url, { max: 4 });
  const story = await seedFeedStory(admin, { nowMs: NOW });
  await seedChainRead(admin, {
    activity: [{
      checkpoint: 39_500, tx_slot: 0, event_slot: 0, part: 0, timestamp_ms: NOW - 25 * HOUR, digest: "FsDayOld".padEnd(44, "1"),
      kind: "presale_commit", product: "presale", actor: FEED_STORY_WALLETS.kai, tx_sender: FEED_STORY_WALLETS.kai,
      presale_id: FEED_STORY_PRESALES.open, coin_type: `${FEED_STORY_PRESALES.open}::coin::X`, quote_type: FEED_STORY_QUOTE_TYPE,
      quote_amount: "20000000", coin_amount: null, quote_refund: null, usd_value: "20", usd_price_as_of_ms: NOW - 25 * HOUR,
      venue: null, participants_after: null, total_commitments_after: null,
    }],
  });
  await admin.query("INSERT INTO social_blocked_terms (term, added_by) VALUES ($1, 'fixture')", [BLOCKED]);

  const replicaPool = createRuntimePool(urlAs(url, "blast_replica"), POOL, "social-whys-replica");
  const webPool = createRuntimePool(urlAs(url, "blast_web"), POOL, "social-whys-web");
  let clock = NOW;
  try {
    const replica = autocommitReader(replicaPool, "social");
    const reader = createSocialConfigReader(autocommitReader(webPool, "social"), { now: () => 0 });
    // Trades hidden, as for an outsider while trading is off: their items are not found.
    const kit = createSocialRouteKit({
      tradingVisible: () => false,
      expectedOrigin: ORIGIN,
      verifyAccessToken: createPrivyTokenVerifier({
        appId: APP_ID,
        verificationKey: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
      }),
      limiter: new PostgresRateLimitEnforcer({ pool: webPool, subjectPepper: PEPPER }),
      accounts: new PostgresSocialAccounts(() => webPool),
      primary: () => webPool,
      // Every answer records its metric line, so the log check sees all of them.
      metricSampleRate: 1,
    });
    const whys = createSocialWhyRoutes({
      kit,
      config: reader.getSocialConfig,
      findBlockedTerm: reader.findBlockedTerm,
      now: () => clock,
    });
    const common = { kit, database: () => replica, config: reader.getSocialConfig, now: () => clock };
    const posts = createSocialPostRoutes(common);
    const feed = createSocialFeedRoute(common);
    await run({
      admin,
      story,
      kaiDayOld: activityEntryId("39500:0:0:0"),
      setNow: (ms) => {
        clock = ms;
      },
      why: (entryId, callsign, body, init = {}) =>
        whys.create.POST(new Request(`${ORIGIN}${init.path ?? socialItemWhyPath(entryId)}`, {
          method: "POST",
          headers: {
            "content-type": init.type ?? "application/json",
            ...(callsign ? { authorization: bearer(did(callsign)) } : {}),
          },
          body: init.raw ?? JSON.stringify(body),
        }), testClient()),
      del: (whyId, callsign, init = {}) =>
        whys.remove.DELETE(new Request(`${ORIGIN}${init.path ?? socialWhyPath(whyId)}`, {
          method: "DELETE",
          headers: { ...(callsign ? { authorization: bearer(did(callsign)) } : {}) },
        }), testClient()),
      report: (whyId, callsign, body, init = {}) =>
        whys.report.POST(new Request(`${ORIGIN}${init.path ?? socialWhyReportsPath(whyId)}`, {
          method: "POST",
          headers: {
            "content-type": init.type ?? "application/json",
            ...(callsign ? { authorization: bearer(did(callsign)) } : {}),
          },
          body: init.raw ?? JSON.stringify(body),
        }), testClient()),
      item: async (entryId) => {
        const response = await posts.item.GET(new Request(`${ORIGIN}${socialItemPath(entryId)}`, { headers: { "x-forwarded-for": "203.0.113.9" } }), testClient("203.0.113.9"));
        assert.equal(response.status, 200);
        return (await response.json()) as SocialItemResponse;
      },
      feed: async () => {
        const response = await feed.GET(new Request(`${ORIGIN}/api/social/feed`, { headers: { "x-forwarded-for": "203.0.113.9" } }), testClient("203.0.113.9"));
        assert.equal(response.status, 200);
        return (await response.json()) as SocialFeedPage;
      },
    });
  } finally {
    await Promise.all([admin.end(), replicaPool.end(), webPool.end()]);
    await database.drop();
  }
}

async function created(response: Response): Promise<SocialWhyCreated> {
  const body: unknown = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  assert.deepEqual(validator.validate("why-response", body).errors, []);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(response.headers.get("x-request-id"));
  return body as SocialWhyCreated;
}

async function refused(response: Response, status: number, code: string, extra: Record<string, unknown> = {}): Promise<void> {
  const body = (await response.json()) as { error: Record<string, unknown> };
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(body.error.code, code);
  for (const [key, value] of Object.entries(extra)) assert.equal(body.error[key], value, key);
  assert.deepEqual(validator.validate("error", body).errors, []);
  assert.equal(response.headers.get("cache-control"), "no-store");
  if (status === 429 || status === 503) assert.ok(Number(response.headers.get("retry-after")) > 0);
}

async function reported(response: Response, status: number, alreadyReported: boolean, whyId: string): Promise<void> {
  const body: unknown = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  assert.deepEqual(validator.validate("why-report-response", body).errors, []);
  assert.deepEqual(body, { why_id: whyId, already_reported: alreadyReported } satisfies SocialWhyReported);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(response.headers.get("x-request-id"));
}

/** A `204` with no body, the kit's headers and nothing cached. */
async function noContent(response: Response): Promise<void> {
  assert.equal(response.status, 204, await response.clone().text());
  assert.equal(await response.text(), "");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(response.headers.get("x-request-id"));
}

/** One why's stored row: its state, and whether each timestamp is set. */
async function whyRow(admin: Pool, whyId: string): Promise<{ state: string; text: string; deleted: boolean; removed: boolean } | null> {
  const { rows } = await admin.query<{ state: string; text: string; deleted: boolean; removed: boolean }>(
    "SELECT state, text, deleted_at IS NOT NULL AS deleted, removed_at IS NOT NULL AS removed FROM social_whys WHERE why_id = $1",
    [whyId],
  );
  return rows[0] ?? null;
}

/** One why's stored reports, oldest first: who reported it and the reason as stored. */
async function reports(admin: Pool, whyId: string): Promise<{ callsign: string; reason: string | null }[]> {
  const { rows } = await admin.query<{ callsign: string; reason: string | null }>(
    `SELECT a.callsign, r.reason FROM social_why_reports r JOIN social_accounts a ON a.account_id = r.reporter_account_id
     WHERE r.why_id = $1 ORDER BY r.created_at, a.callsign`,
    [whyId],
  );
  return rows;
}

async function records(admin: Pool, entryId: string): Promise<{ state: string; text: string; callsign: string }[]> {
  const result = await admin.query<{ state: string; text: string; callsign: string }>(
    `SELECT w.state, w.text, a.callsign FROM social_whys w JOIN social_accounts a ON a.account_id = w.author_account_id
     WHERE w.entry_id = $1 ORDER BY w.created_at, w.why_id`,
    [entryId],
  );
  return result.rows;
}

test("T-021-AC-1 (AC-076): the author within 24 h gets 201 and the item shows it; another account is not_author; after 24 h the window is closed", { skip }, () =>
  withFixture(async ({ admin, story, kaiDayOld, setNow, why, item, feed }) => {
    const entry = story.ids.kaiTieHigh;
    assert.equal((await item(entry)).item.why, null);

    await refused(await why(entry, "nova", { text: "Not mine to explain." }), 403, "not_author");
    const first = await created(await why(entry, "kai", { text: "Third raise from this team, and the first I could join." }));
    assert.equal(first.text, "Third raise from this team, and the first I could join.");
    assert.deepEqual((await item(entry)).item.why, { why_id: first.why_id, text: first.text });
    // The For You boost applies at once: the 12-minute-old item now leads the 10-minute-old plain commit.
    const order = (await feed()).items.map((candidate) => candidate.entry_id);
    assert.ok(order.indexOf(entry) < order.indexOf(story.ids.novaPlainCommit), "the why's boost ranks the item up");
    assert.deepEqual(await records(admin, entry), [{ state: "active", text: first.text, callsign: "kai" }]);

    // The item's time plus exactly 24 h is still inside; a millisecond later is not.
    const occurred = (await item(story.ids.kaiTieLow)).item.occurred_at_ms;
    setNow(occurred + WHY_WINDOW_MS + 1);
    await refused(await why(story.ids.kaiTieLow, "kai", { text: "Late to explain." }), 409, "why_window_closed");
    setNow(occurred + WHY_WINDOW_MS);
    await created(await why(story.ids.kaiTieLow, "kai", { text: "Just in time." }));
    setNow(NOW);
    await refused(await why(kaiDayOld, "kai", { text: "A day later." }), 409, "why_window_closed");

    // Only a named actor writes one: presale posts by an unowned wallet, lifecycle posts, unnamed items.
    await refused(await why(story.ids.anonBigOpen, "kai", { text: "Not my wallet." }), 403, "not_author");
    await refused(await why(story.ids.openOpened, "kai", { text: "A sale opened." }), 403, "not_author");
    await refused(await why(story.ids.ghostSmallCommit, "kai", { text: "Private." }), 404, "not_found");
    await refused(await why("a:999999:0:0:0", "kai", { text: "Nothing." }), 404, "not_found");
    // Trades are hidden from the feed while trading is off (OA-7): not found.
    await refused(await why(story.ids.kaiBuy, "kai", { text: "A trade." }), 404, "not_found");
    // Signed out, no account, a malformed id, a malformed or open body.
    await refused(await why(entry, null, { text: "x" }), 401, "unauthorized");
    await refused(await why(entry, "nobody_here", { text: "x" }), 409, "account_required");
    await refused(await why("", "mallory", { text: "x" }, { path: "/api/social/items/not%20an%20id/why" }), 400, "invalid_parameter", { parameter: "entry_id" });
    await refused(await why(entry, "mallory", { text: "x", extra: 1 }), 400, "invalid_request");
    await refused(await why(entry, "mallory", { text: 7 }), 400, "invalid_request");
    await refused(await why(entry, "mallory", null, { raw: "text=x", type: "text/plain" }), 400, "invalid_request");
    await refused(await why(entry, "mallory", null, { raw: JSON.stringify({ text: "x".repeat(5_000) }) }), 413, "body_too_large");
  }));

test("T-021-AC-2 (AC-077) and AC-3 (AC-078): empty, length, line breaks and links are refused; NFC text is stored trimmed", { skip }, () =>
  withFixture(async ({ admin, story, why }) => {
    const entry = story.ids.kaiTieHigh;
    await refused(await why(entry, "kai", { text: "  " }), 422, "why_empty");
    await refused(await why(entry, "kai", { text: "\u3000\t " }), 422, "why_empty");
    await refused(await why(entry, "kai", { text: "\u{1F680}".repeat(281) }), 422, "why_too_long");
    await refused(await why(entry, "kai", { text: "first line\nsecond line" }), 422, "why_invalid");
    await refused(await why(entry, "kai", { text: "first line\u2028second" }), 422, "why_invalid");
    for (const text of ["see https://x.io", "www.x", "blast.fun", "BLAST.FUN", "go to Blast.Fun/p/1 now", "HTTP://x"]) {
      await refused(await why(entry, "kai", { text }), 422, "why_has_link");
    }
    assert.deepEqual(await records(admin, entry), [], "nothing stored for a refused text");

    // "Caf\u00e9" with a combining accent, padded: stored composed and trimmed.
    const stored = await created(await why(entry, "kai", { text: "  Cafe\u0301 team, v2.0 soon. " }));
    assert.equal(stored.text, "Caf\u00e9 team, v2.0 soon.");
    assert.equal((await records(admin, entry))[0]?.text, "Caf\u00e9 team, v2.0 soon.");
    // 280 code points (560 UTF-16 units) is the most.
    await created(await why(story.ids.kaiTieLow, "kai", { text: "\u{1F680}".repeat(280) }));
  }));

test("T-021-AC-4 (AC-079, AC-080): blocked terms; why_exists, why_removed and why_limit", { skip }, () =>
  withFixture(async ({ admin, story, why }) => {
    const entry = story.ids.kaiTieHigh;
    await refused(await why(entry, "kai", { text: `Buy this RugPullCoin now` }), 422, "blocked_term", { field: "text" });

    const first = await created(await why(entry, "kai", { text: "One." }));
    await refused(await why(entry, "kai", { text: "Two." }), 409, "why_exists");
    // The team removes it (T-023's command writes these columns): no new why on that item, ever.
    await admin.query(
      "UPDATE social_whys SET state = 'removed', removed_at = now(), removed_by = 'ops.fixture', removal_reason = 'spam' WHERE why_id = $1",
      [first.why_id],
    );
    await refused(await why(entry, "kai", { text: "Three." }), 409, "why_removed");

    // Three records in any state: the author deleted two (T-022's route writes these columns), the third is active.
    const other = story.ids.kaiTieLow;
    const deleteWhy = (whyId: string) =>
      admin.query("UPDATE social_whys SET state = 'deleted', deleted_at = now() WHERE why_id = $1", [whyId]);
    await deleteWhy((await created(await why(other, "kai", { text: "A." }))).why_id);
    await deleteWhy((await created(await why(other, "kai", { text: "B." }))).why_id);
    const third = await created(await why(other, "kai", { text: "C." }));
    await refused(await why(other, "kai", { text: "D." }), 409, "why_exists");
    await deleteWhy(third.why_id);
    await refused(await why(other, "kai", { text: "D." }), 409, "why_limit");
    assert.equal((await records(admin, other)).length, 3);

    // A why is never edited, and a deleted one stays deleted, for every role (0079).
    await assert.rejects(admin.query("UPDATE social_whys SET text = 'edited' WHERE why_id = $1", [third.why_id]), {
      code: "23514",
      constraint: "social_whys_never_edited",
    });
    await assert.rejects(admin.query("UPDATE social_whys SET state = 'active', deleted_at = NULL WHERE why_id = $1", [third.why_id]), {
      code: "23514",
      constraint: "social_whys_transition",
    });
  }));

test("T-021: two first whys on one item at once store exactly one", { skip }, () =>
  withFixture(async ({ admin, story, why }) => {
    const entry = story.ids.kaiTieHigh;
    const answers = await Promise.all(Array.from({ length: 6 }, (_, n) => why(entry, "kai", { text: `Race ${n}.` })));
    const statuses = answers.map((answer) => answer.status).sort();
    assert.deepEqual(statuses, [201, 409, 409, 409, 409, 409]);
    assert.equal((await records(admin, entry)).length, 1);
  }));

test("T-021-AC-5 (AC-126, AC-130): the 21st why write in an hour is 429 with Retry-After; no log line carries a why's text", { skip }, () =>
  withFixture(async ({ story, why }) => {
    // The limiter's windows are whole hours: start with at least a minute of this one left.
    const left = HOUR - (Date.now() % HOUR);
    if (left < 60_000) await new Promise((resolve) => setTimeout(resolve, left + 1_000));
    const secret = "secret-why-text-7f3a";
    const lines: string[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const originals = methods.map((method) => console[method]);
    for (const method of methods) {
      console[method] = (...args: unknown[]) => {
        lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg) ?? String(arg))).join(" "));
      };
    }
    try {
      // Refusals count too: 19 refused, then one stored, then the 21st is limited.
      for (let n = 0; n < 19; n += 1) {
        const response = await why(story.ids.kaiTieHigh, "kai", { text: `${secret} https://link.example/${n}` });
        assert.equal(response.status, 422);
      }
      await created(await why(story.ids.kaiTieHigh, "kai", { text: `${secret} stored` }));
      await refused(await why(story.ids.kaiTieLow, "kai", { text: `${secret} limited` }), 429, "rate_limited");
      // Another account has its own bucket.
      await refused(await why(story.ids.kaiTieLow, "nova", { text: `${secret} not mine` }), 403, "not_author");
    } finally {
      methods.forEach((method, n) => {
        console[method] = originals[n] as (typeof console)[typeof method];
      });
    }
    assert.ok(lines.some((line) => line.includes("social.route")), "the route's metric lines were captured");
    assert.deepEqual(lines.filter((line) => line.includes(secret)), []);
  }));

test("T-022-AC-1 (AC-082): the author's delete is 204, the record stays deleted, the item drops it, and a new why in the window succeeds", { skip }, () =>
  withFixture(async ({ admin, story, del, why, item, feed }) => {
    const entry = story.ids.kaiTieHigh;
    const first = await created(await why(entry, "kai", { text: "Third raise from this team." }));

    // Nobody else retracts it, and nothing changes when they try.
    await refused(await del(first.why_id, "nova"), 403, "not_author");
    assert.deepEqual(await whyRow(admin, first.why_id), { state: "active", text: first.text, deleted: false, removed: false });

    await noContent(await del(first.why_id, "kai"));
    assert.deepEqual(await whyRow(admin, first.why_id), { state: "deleted", text: first.text, deleted: true, removed: false });
    assert.equal((await item(entry)).item.why, null);
    assert.equal((await feed()).items.find((candidate) => candidate.entry_id === entry)?.why, null);

    // Retrying is idempotent: the same answer, the same one record.
    await noContent(await del(first.why_id, "kai"));
    assert.equal((await records(admin, entry)).length, 1);

    // And the author may explain the item again inside its 24 hours.
    const second = await created(await why(entry, "kai", { text: "Second try, same conviction." }));
    assert.deepEqual((await item(entry)).item.why, { why_id: second.why_id, text: second.text });
    assert.deepEqual((await records(admin, entry)).map((row) => row.state), ["deleted", "active"]);

    // The team's removal is not the author's to turn into a deletion.
    await admin.query(
      "UPDATE social_whys SET state = 'removed', removed_at = now(), removed_by = 'ops.fixture', removal_reason = 'spam' WHERE why_id = $1",
      [second.why_id],
    );
    await refused(await del(second.why_id, "kai"), 409, "why_removed");
    assert.equal((await whyRow(admin, second.why_id))?.state, "removed");

    // An unknown or malformed id, and the callers the kit refuses.
    await refused(await del("00000000-0000-4000-8000-000000000000", "kai"), 404, "not_found");
    await refused(await del(first.why_id, null), 401, "unauthorized");
    await refused(await del(first.why_id, "nobody_here"), 409, "account_required");
    for (const path of [
      "/api/social/whys/not-a-uuid",
      `/api/social/whys/${first.why_id.toUpperCase()}`,
      `/api/social/whys/${first.why_id}/extra`,
      "/api/social/whys/",
      "/api/social/whys/%E0%A4%A",
    ]) {
      await refused(await del(first.why_id, "kai", { path }), 400, "invalid_parameter", { parameter: "why_id" });
    }
  }));

test("T-022-AC-2 (AC-083): a report stores one row per account, a repeat is 200 with nothing added, and a self-report is refused", { skip }, () =>
  withFixture(async ({ admin, story, del, report, why }) => {
    const entry = story.ids.kaiTieHigh;
    const subject = await created(await why(entry, "kai", { text: "Been following this team for months." }));

    // "Café claim" with a combining accent, padded: the reason is stored composed and trimmed.
    await reported(await report(subject.why_id, "nova", { reason: "  Misleading Café claim " }), 201, false, subject.why_id);
    assert.deepEqual(await reports(admin, subject.why_id), [{ callsign: "nova", reason: "Misleading Café claim" }]);

    // The same account again: 200, no second row, and the first reason stands.
    await reported(await report(subject.why_id, "nova", { reason: "Changed my mind" }), 200, true, subject.why_id);
    assert.deepEqual(await reports(admin, subject.why_id), [{ callsign: "nova", reason: "Misleading Café claim" }]);

    // Another account's report is its own row; a reason is optional and a blank one stores none.
    await reported(await report(subject.why_id, "mallory", {}), 201, false, subject.why_id);
    await reported(await report(subject.why_id, "late_one", { reason: " 　 " }), 201, false, subject.why_id);
    assert.deepEqual(await reports(admin, subject.why_id), [
      { callsign: "nova", reason: "Misleading Café claim" },
      { callsign: "mallory", reason: null },
      { callsign: "late_one", reason: null },
    ], "one row per reporter, in the order they reported");

    // The author never reports their own why.
    await refused(await report(subject.why_id, "kai", {}), 422, "cannot_report_self");

    // 280 code points is the most a reason holds, counted as code points.
    await reported(await report(subject.why_id, "ghost", { reason: "\u{1F680}".repeat(280) }), 201, false, subject.why_id);
    await refused(await report(subject.why_id, "nova", { reason: "\u{1F680}".repeat(281) }), 400, "invalid_request");
    await refused(await report(subject.why_id, "nova", { reason: "a".repeat(281) }), 400, "invalid_request");
    // A closed body: a reason that is not a string, an unknown key, another content type, an over-large body.
    await refused(await report(subject.why_id, "nova", { reason: 7 }), 400, "invalid_request");
    await refused(await report(subject.why_id, "nova", { reason: "why", extra: 1 }), 400, "invalid_request");
    await refused(await report(subject.why_id, "nova", null, { raw: "reason=x", type: "text/plain" }), 400, "invalid_request");
    await refused(await report(subject.why_id, "nova", null, { raw: JSON.stringify({ reason: "x".repeat(5_000) }) }), 413, "body_too_large");
    assert.equal((await reports(admin, subject.why_id)).length, 4, "a refused report stores nothing");

    // Nothing to report on an unknown why, nor on one that is hidden (deleted or removed).
    await refused(await report("00000000-0000-4000-8000-000000000000", "nova", {}), 404, "not_found");
    await noContent(await del(subject.why_id, "kai"));
    await refused(await report(subject.why_id, "late_one", {}), 404, "not_found");
    const removable = await created(await why(story.ids.kaiTieLow, "kai", { text: "Another item, another why." }));
    await admin.query(
      "UPDATE social_whys SET state = 'removed', removed_at = now(), removed_by = 'ops.fixture' WHERE why_id = $1",
      [removable.why_id],
    );
    await refused(await report(removable.why_id, "nova", {}), 404, "not_found");

    // The kit's callers and the path parameter.
    await refused(await report(subject.why_id, null, {}), 401, "unauthorized");
    await refused(await report(subject.why_id, "nobody_here", {}), 409, "account_required");
    for (const path of [
      "/api/social/whys/not-a-uuid/reports",
      `/api/social/whys/${subject.why_id}/report`,
      `/api/social/whys/${subject.why_id}/reports/1`,
      `/api/social/whys/${subject.why_id}`,
    ]) {
      await refused(await report(subject.why_id, "nova", {}, { path }), 400, "invalid_parameter", { parameter: "why_id" });
    }
  }));

test("T-022: two first reports of one why by one account store exactly one row", { skip }, () =>
  withFixture(async ({ admin, story, report, why }) => {
    const subject = await created(await why(story.ids.kaiTieHigh, "kai", { text: "One line, one why." }));
    const answers = await Promise.all(Array.from({ length: 6 }, (_, n) => report(subject.why_id, "nova", { reason: `Race ${n}` })));
    const statuses = answers.map((answer) => answer.status).sort();
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 201]);
    assert.equal((await reports(admin, subject.why_id)).length, 1);
  }));

test("T-022-AC-3 (AC-126, AC-130): deletes count in social_why and reports in social_report, each 429 with Retry-After; no log line carries a reason", { skip }, () =>
  withFixture(async ({ admin, story, del, report, why }) => {
    // The limiter's windows are whole hours: start with at least a minute of this one left.
    const left = HOUR - (Date.now() % HOUR);
    if (left < 60_000) await new Promise((resolve) => setTimeout(resolve, left + 1_000));
    const subject = await created(await why(story.ids.kaiTieHigh, "kai", { text: "Worth explaining." }));
    const unknown = "00000000-0000-4000-8000-000000000000";
    const secret = "secret-report-reason-1b9c";
    const lines: string[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const originals = methods.map((method) => console[method]);
    for (const method of methods) {
      console[method] = (...args: unknown[]) => {
        lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg) ?? String(arg))).join(" "));
      };
    }
    try {
      // Deleting shares the why bucket (20 per hour): 20 answered, the 21st is limited.
      for (let n = 0; n < 20; n += 1) await refused(await del(unknown, "nova"), 404, "not_found");
      await refused(await del(unknown, "nova"), 429, "rate_limited");
      // Reports have their own bucket (30 per hour) and their own account: 30 answered, the 31st is limited.
      for (let n = 0; n < 29; n += 1) await refused(await report(unknown, "mallory", { reason: `${secret} ${n}` }), 404, "not_found");
      await reported(await report(subject.why_id, "mallory", { reason: `${secret} stored` }), 201, false, subject.why_id);
      await refused(await report(subject.why_id, "mallory", { reason: `${secret} limited` }), 429, "rate_limited");
      // Another account still reports, and the limited account's why is untouched.
      await reported(await report(subject.why_id, "nova", { reason: `${secret} mine` }), 201, false, subject.why_id);
    } finally {
      methods.forEach((method, n) => {
        console[method] = originals[n] as (typeof console)[typeof method];
      });
    }
    assert.ok(lines.some((line) => line.includes("social.route")), "the route's metric lines were captured");
    assert.deepEqual(lines.filter((line) => line.includes(secret)), []);
    // The reasons reached the table, and only it.
    assert.deepEqual(await reports(admin, subject.why_id), [
      { callsign: "mallory", reason: `${secret} stored` },
      { callsign: "nova", reason: `${secret} mine` },
    ]);
  }));
