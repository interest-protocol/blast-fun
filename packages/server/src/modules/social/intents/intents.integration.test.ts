import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import type { Pool } from "pg";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import { createSocialConfigReader } from "@blast/core/modules/social/config/reader.ts";
import { SOCIAL_INTENTS_PATH, type SocialIntentRecorded } from "@blast/core/modules/social/contracts/intents.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { FEED_STORY_PRESALES, seedFeedStory, type FeedStory } from "../../../../../core/test/fixtures/modules/social/feed/feed-story.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { createSocialIntentRoutes } from "@blast/server/modules/social/intents/route.ts";

/**
 * Social feed T-024 (AC-094, AC-095, AC-081, AC-126, AC-130): registering an
 * intent over a disposable database with the fixture `chain_read_v1` and the
 * feed story. The route runs as `blast_web` on the primary, as in production.
 *
 * The browser's half of the ticket — the call is made after the digest and
 * before execute, bounded at 3 s, and never blocks — is proved in
 * `src/components/social/commit/commit-flow.test.ts` with a mock transport,
 * because no database can observe the order of two network calls.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "social-intents-app";
const PEPPER = "social-intents-fixture-pepper-0123456789ab";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const validator = createSocialValidator();
const POOL = { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 8, statementTimeoutMs: 10_000 };
const NOW = Date.now();
const MINUTE = 60_000;
const BLOCKED = "rugpullcoin";

const did = (callsign: string) => `did:privy:feed-story-${callsign}`;

/**
 * A base58 digest of the right shape, one per label. The label cannot simply
 * be spelled into the digest: base58 has no `0`, `O`, `I` or `l`, and the
 * route refuses anything that is not a digest Sui could have produced.
 */
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const digests = new Map<string, string>();
function digestOf(label: string): string {
  const existing = digests.get(label);
  if (existing !== undefined) return existing;
  const n = digests.size + 1;
  const digest = `Fs${BASE58[Math.floor(n / 58)]!}${BASE58[n % 58]!}`.padEnd(44, "2");
  digests.set(label, digest);
  return digest;
}

function bearer(subject: string): string {
  const now = Math.floor(Date.now() / 1_000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: now + 3_600, iat: now - 60, iss: "privy.io", sid: "s-1", sub: subject });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `Bearer ${header}.${payload}.${signature.toString("base64url")}`;
}

type IntentBody = Readonly<Record<string, unknown>>;

type IntentRow = Readonly<{
  tx_digest: string;
  account_id: string;
  action: string;
  presale_id: string;
  source_entry_id: string | null;
  why_text: string | null;
  status: string;
  resolved_at: string | null;
}>;

type Fixture = Readonly<{
  admin: Pool;
  story: FeedStory;
  register(body: IntentBody, callsign: string | null, init?: { raw?: string; type?: string; path?: string }): Promise<Response>;
  row(digest: string): Promise<IntentRow | undefined>;
}>;

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const database = await freshTestDatabase();
  const admin = createPool(database.url, { max: 4 });
  const story = await seedFeedStory(admin, { nowMs: NOW });
  await admin.query("INSERT INTO social_blocked_terms (term, added_by) VALUES ($1, 'fixture')", [BLOCKED]);

  const webPool = createRuntimePool(urlAs(database.url, "blast_web"), POOL, "social-intents-web");
  try {
    const reader = createSocialConfigReader(autocommitReader(webPool, "social"), { now: () => 0 });
    const kit = createSocialRouteKit({
      tradingVisible: () => true,
      expectedOrigin: ORIGIN,
      verifyAccessToken: createPrivyTokenVerifier({
        appId: APP_ID,
        verificationKey: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
      }),
      limiter: new PostgresRateLimitEnforcer({ pool: webPool, subjectPepper: PEPPER }),
      accounts: new PostgresSocialAccounts(() => webPool),
      primary: () => webPool,
      metricSampleRate: 1,
    });
    const intents = createSocialIntentRoutes({ provenance: async () => {}, kit, config: reader.getSocialConfig, findBlockedTerm: reader.findBlockedTerm });
    await run({
      admin,
      story,
      register: (body, callsign, init = {}) =>
        intents.register.POST(new Request(`${ORIGIN}${init.path ?? SOCIAL_INTENTS_PATH}`, {
          method: "POST",
          headers: {
            "content-type": init.type ?? "application/json",
            ...(callsign ? { authorization: bearer(did(callsign)) } : {}),
          },
          body: init.raw ?? JSON.stringify(body),
        }), testClient()),
      row: async (digest) => {
        const { rows } = await admin.query<IntentRow>(
          "SELECT tx_digest, account_id, action, presale_id, source_entry_id, why_text, status, resolved_at FROM social_intents WHERE tx_digest = $1",
          [digest],
        );
        return rows[0];
      },
    });
  } finally {
    await Promise.all([admin.end(), webPool.end()]);
    await database.drop();
  }
}

async function recorded(response: Response, status: number, expected: SocialIntentRecorded): Promise<void> {
  const body: unknown = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  assert.deepEqual(validator.validate("intent-response", body).errors, []);
  assert.deepEqual(body, expected);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(response.headers.get("x-request-id"));
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

const commit = (digest: string, extra: IntentBody = {}): IntentBody => ({
  action: "commit",
  presale_id: FEED_STORY_PRESALES.open,
  tx_digest: digest,
  ...extra,
});

test("T-024-AC-1 (AC-094, AC-081): a first registration records; a repeat is a duplicate that writes nothing", { skip }, () =>
  withFixture(async ({ register, row }) => {
    const digest = digestOf("First");
    await recorded(await register(commit(digest, { why: "Great team, real product." }), "kai"), 201, {
      status: "recorded",
      why: "accepted",
    });
    const stored = await row(digest);
    assert.equal(stored?.action, "commit");
    assert.equal(stored?.presale_id, FEED_STORY_PRESALES.open);
    assert.equal(stored?.why_text, "Great team, real product.");
    assert.equal(stored?.status, "pending");
    assert.equal(stored?.resolved_at, null);
    assert.equal(stored?.source_entry_id, null);

    // The same digest from the same account: the first registration stands,
    // and a retried call after a timeout cannot overwrite the stored why.
    await recorded(await register(commit(digest, { why: "A different why." }), "kai"), 200, { status: "duplicate", why: null });
    assert.equal((await row(digest))?.why_text, "Great team, real product.");

    // Without a why nothing is claimed about one.
    const plain = digestOf("Plain");
    await recorded(await register(commit(plain), "kai"), 201, { status: "recorded", why: null });
    assert.equal((await row(plain))?.why_text, null);
  }));

test("T-024-AC-1 (AC-081): a why that fails is reported and not stored, and the intent is still recorded", { skip }, () =>
  withFixture(async ({ register, row }) => {
    const cases: readonly (readonly [string, string, string])[] = [
      ["Linked", "see https://blast.example", "why_has_link"],
      ["Domain", "check blast.fun for more", "why_has_link"],
      ["Long", "x".repeat(281), "why_too_long"],
      ["Lines", "two\nlines", "why_invalid"],
      ["Blank", "   ", "why_empty"],
      ["Blocked", `the ${BLOCKED} people are in`, "blocked_term"],
    ];
    for (const [label, why, code] of cases) {
      const digest = digestOf(label);
      await recorded(await register(commit(digest, { why }), "kai"), 201, { status: "recorded", why: code as never });
      const stored = await row(digest);
      assert.equal(stored?.why_text, null, label);
      assert.equal(stored?.status, "pending", label);
    }
    // A why at exactly the limit is stored, NFC-normalized and trimmed.
    const edge = digestOf("Edge");
    await recorded(await register(commit(edge, { why: `  ${"\u{1F680}".repeat(280)}  ` }), "kai"), 201, { status: "recorded", why: "accepted" });
    assert.equal((await row(edge))?.why_text, "\u{1F680}".repeat(280));
  }));

test("T-024-AC-2 (AC-095): the same digest from another account is 409 digest_taken", { skip }, () =>
  withFixture(async ({ admin, register, row }) => {
    const digest = digestOf("Taken");
    await recorded(await register(commit(digest), "kai"), 201, { status: "recorded", why: null });
    await refused(await register(commit(digest), "nova"), 409, "digest_taken");
    // Nothing of the second account's registration reached the row.
    const stored = await row(digest);
    assert.equal(stored?.why_text, null);
    const { rows } = await admin.query<{ n: string }>("SELECT count(*)::text AS n FROM social_intents WHERE tx_digest = $1", [digest]);
    assert.equal(rows[0]?.n, "1");
    // And the second account can still register its own digest.
    await recorded(await register(commit(digestOf("Novas")), "nova"), 201, { status: "recorded", why: null });
  }));

test("R3-27: the first registration logs the account's commit, submitted with its digest; nothing else logs", { skip }, () =>
  withFixture(async ({ admin, register }) => {
    type LogRow = Readonly<{ account: string; kind: string; state: string; digest: string | null; presale_id: string | null; quote_type: string | null; quote_amount: string | null; usd_value: string | null; settled_at_ms: string | null }>;
    const logged = async (digest: string) =>
      (
        await admin.query<LogRow>(
          `SELECT a.callsign AS account, t.kind, t.state, t.digest, t.presale_id, t.quote_type, t.quote_amount::text, t.usd_value::text, t.settled_at_ms::text
           FROM social_transactions t JOIN social_accounts a USING (account_id) WHERE t.idempotency_key = $1`,
          [`commit:${digest}`],
        )
      ).rows;
    const USDC = `0x${"db".repeat(32)}::usdc::USDC`;
    const digest = digestOf("Logged");
    await recorded(
      await register(commit(digest, { why: "In.", quote_type: USDC, quote_amount: "50000000", usd_value: "50.00" }), "kai"),
      201,
      { status: "recorded", why: "accepted" },
    );
    assert.deepEqual(await logged(digest), [{
      account: "kai",
      kind: "commit",
      state: "submitted",
      digest,
      presale_id: FEED_STORY_PRESALES.open,
      quote_type: USDC,
      quote_amount: "50000000",
      usd_value: "50.00",
      settled_at_ms: null,
    }]);
    // A retried registration and another account's claim on the digest log nothing.
    await recorded(await register(commit(digest, { quote_type: USDC, quote_amount: "1" }), "kai"), 200, { status: "duplicate", why: null });
    await refused(await register(commit(digest), "nova"), 409, "digest_taken");
    assert.equal((await logged(digest)).length, 1);
    // Without the facts the row still exists: the commit and its digest, no amounts.
    const bare = digestOf("Bare");
    await recorded(await register(commit(bare), "kai"), 201, { status: "recorded", why: null });
    assert.deepEqual((await logged(bare)).map((row) => [row.state, row.digest, row.quote_type, row.quote_amount, row.usd_value]), [
      ["submitted", bare, null, null, null],
    ]);
    // A malformed fact refuses the body before anything is written.
    for (const extra of [{ quote_amount: "5" }, { quote_type: USDC, quote_amount: "18446744073709551616" }, { usd_value: "1.234" }, { quote_type: "0x2::sui::SUI" }]) {
      const bad = digestOf(`Bad${Object.keys(extra).join("")}${String(Object.values(extra)[0]).length}`);
      await refused(await register(commit(bad, extra), "kai"), 400, "invalid_request");
      assert.equal((await logged(bad)).length, 0);
    }
  }));

test("T-024: the source item is stored only when it is visible at registration", { skip }, () =>
  withFixture(async ({ admin, register, row, story }) => {
    // A named commit of a public account: visible.
    const visible = digestOf("Visible");
    await recorded(await register(commit(visible, { source_entry_id: story.ids.kaiWhyCommit }), "nova"), 201, { status: "recorded", why: null });
    assert.equal((await row(visible))?.source_entry_id, story.ids.kaiWhyCommit);

    // A lifecycle post is visible with no actor at all.
    const lifecycle = digestOf("Lifecycle");
    await recorded(await register(commit(lifecycle, { source_entry_id: story.ids.openOpened }), "nova"), 201, { status: "recorded", why: null });
    assert.equal((await row(lifecycle))?.source_entry_id, story.ids.openOpened);

    // A small commit by a private account is not visible: stored as null, so
    // attribution can never read it later (T-026 relies on exactly this).
    const hidden = digestOf("Hidden");
    await recorded(await register(commit(hidden, { source_entry_id: story.ids.ghostSmallCommit }), "nova"), 201, { status: "recorded", why: null });
    assert.equal((await row(hidden))?.source_entry_id, null);

    // An id of nothing at all is stored as null rather than refused: the
    // transaction is signed, and a stale feed is not the person's fault.
    const unknown = digestOf("Unknown");
    await recorded(await register(commit(unknown, { source_entry_id: "a:1:0:0:0" }), "nova"), 201, { status: "recorded", why: null });
    assert.equal((await row(unknown))?.source_entry_id, null);

    // Going private after the registration leaves the stored source alone.
    // Going private clears `sharing_since` (0054's `social_accounts_private_not_sharing`).
    await admin.query("UPDATE social_accounts SET privacy = 'private', sharing_since = NULL WHERE callsign = 'kai'");
    assert.equal((await row(visible))?.source_entry_id, story.ids.kaiWhyCommit);
  }));

test("T-024: the swap feature's actions and every malformed field are refused before anything is written", { skip }, () =>
  withFixture(async ({ register, row }) => {
    const digest = digestOf("Bad");
    for (const action of ["buy", "sell", "commit ", "Commit", "", 7, null]) {
      await refused(await register({ ...commit(digest), action }, "kai"), 400, "invalid_request");
    }
    await refused(await register({ ...commit(digest), presale_id: "0xnope" }, "kai"), 400, "invalid_parameter", { parameter: "presale_id" });
    await refused(await register({ ...commit(digest), presale_id: FEED_STORY_PRESALES.open.toUpperCase() }, "kai"), 400, "invalid_parameter", { parameter: "presale_id" });
    await refused(await register({ ...commit("0OIl") }, "kai"), 400, "invalid_parameter", { parameter: "tx_digest" });
    await refused(await register({ ...commit(digest), source_entry_id: "nope" }, "kai"), 400, "invalid_parameter", { parameter: "source_entry_id" });
    await refused(await register({ ...commit(digest), source_entry_id: 7 }, "kai"), 400, "invalid_request");
    await refused(await register({ ...commit(digest), why: 7 }, "kai"), 400, "invalid_request");
    // A closed schema: an unknown key, a missing one, and a body that is not an object.
    await refused(await register({ ...commit(digest), extra: 1 }, "kai"), 400, "invalid_request");
    await refused(await register({ action: "commit", presale_id: FEED_STORY_PRESALES.open }, "kai"), 400, "invalid_request");
    await refused(await register({}, "kai", { raw: "[]" }), 400, "invalid_request");
    await refused(await register({}, "kai", { raw: "{", type: "application/json" }), 400, "invalid_request");
    await refused(await register(commit(digest), "kai", { type: "text/plain" }), 400, "invalid_request");
    await refused(await register({}, "kai", { raw: "x".repeat(5_000) }), 413, "body_too_large");
    assert.equal(await row(digest), undefined);
  }));

test("T-024: a visitor is unauthorized and a signed-in caller without an account needs one", { skip }, () =>
  withFixture(async ({ register, row }) => {
    const digest = digestOf("Auth");
    await refused(await register(commit(digest), null), 401, "unauthorized");
    assert.equal(await row(digest), undefined);
    await refused(await register(commit(digest), "nobody"), 409, "account_required");
    assert.equal(await row(digest), undefined);
    // The same digest is then free for whoever really sent it.
    await recorded(await register(commit(digest), "kai"), 201, { status: "recorded", why: null });
    assert.equal((await row(digest))?.status, "pending");
  }));

test("T-024-AC-4 (AC-126, AC-130): the 61st registration in a minute is 429, and no log line carries a why", { skip }, () =>
  withFixture(async ({ register }) => {
    // The limiter's windows are whole minutes: start with enough of one left.
    const left = MINUTE - (Date.now() % MINUTE);
    if (left < 20_000) await new Promise((resolve) => setTimeout(resolve, left + 500));
    const secret = "secret-why-text-9c1d";
    const lines: string[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const originals = methods.map((method) => console[method]);
    for (const method of methods) {
      console[method] = (...args: unknown[]) => {
        lines.push(args.map((arg) => (typeof arg === "string" ? arg : (JSON.stringify(arg) ?? String(arg)))).join(" "));
      };
    }
    try {
      for (let n = 0; n < 60; n += 1) {
        const response = await register(commit(digestOf(`Rate${n}`), { why: `${secret} https://link.example/${n}` }), "kai");
        assert.equal(response.status, 201);
      }
      const limited = await register(commit(digestOf("Rate60"), { why: `${secret} stored` }), "kai");
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers.get("retry-after")) > 0);
      await limited.text();
    } finally {
      methods.forEach((method, index) => {
        console[method] = originals[index]!;
      });
    }
    assert.ok(lines.length > 0, "the kit recorded its metric lines");
    // Accepted, refused and limited registrations: not one line carries the text.
    for (const line of lines) assert.ok(!line.includes(secret), line);
  }));

test("T-024: two registrations of one digest racing leave one row and one owner", { skip }, () =>
  withFixture(async ({ admin, register, row }) => {
    const digest = digestOf("Race");
    const answers = await Promise.all([
      register(commit(digest, { why: "Mine." }), "kai"),
      register(commit(digest, { why: "No, mine." }), "nova"),
      register(commit(digest), "kai"),
    ]);
    const statuses = answers.map((answer) => answer.status);
    await Promise.all(answers.map((answer) => answer.text()));
    const stored = await row(digest);
    assert.ok(stored);
    assert.equal(stored.status, "pending");
    // The race decides whose insert lands first, so either account may own the
    // digest. Every answer must agree with the one stored row: the owner's
    // first call is recorded, its second (if any) is a duplicate, and the
    // other account is refused.
    const { rows } = await admin.query<{ callsign: string }>("SELECT callsign FROM social_accounts WHERE account_id = $1", [
      stored.account_id,
    ]);
    if (rows[0]?.callsign === "kai") {
      assert.deepEqual([...statuses].sort(), [200, 201, 409]);
      assert.equal(statuses[1], 409, "nova is refused");
    } else {
      assert.equal(rows[0]?.callsign, "nova");
      assert.deepEqual(statuses, [409, 201, 409], "nova recorded it, and both of kai's calls are refused");
      assert.equal(stored.why_text, "No, mine.");
    }
  }));
