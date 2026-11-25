import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import {
  rebuildChainRead,
  type ChainActivityRow,
  type ChainPresaleLifecycleRow,
  type ChainPresaleRow,
} from "../../../../../core/test/fixtures/modules/database/chain-read-rows.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { advanceWatermark, urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";
import { autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { createSocialConfigReader } from "@blast/core/modules/social/config/reader.ts";
import { SOCIAL_CONFIG_DEFAULTS, type SocialConfig } from "@blast/core/modules/social/contracts/config.ts";
import { activityEntryId, lifecycleEntryId, milestoneEntryId } from "@blast/core/modules/social/contracts/feed-entries.ts";
import type { FeedItem } from "@blast/core/modules/social/contracts/items.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import {
  entryFromRow,
  namedOwnerSql,
  personEntriesOf,
  presalePostEntriesOf,
  type FeedEntry,
  type PresalePostThresholds,
} from "@blast/server/modules/social/read-model/index.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { decodeItemCursor, nextItemCursor, readAsOf, toItems } from "@blast/server/modules/social/items/index.ts";

/**
 * Social feed T-005: the item mapper on a disposable database with
 * blast-infra's fixture `chain_read_v1`. One story holds presales in every
 * lifecycle, accounts in every naming state (a Mission Control member, a new
 * account, a private account, a never-onboarded account, an unowned wallet),
 * whys in each state, reactions and attributions. Items are mapped as the
 * replica role, the most restricted reader, and checked against the
 * published schema.
 */
const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const validator = createSocialValidator();

function t(n: number): number {
  return 1_790_000_000_000 + n * 1_000;
}
const NOW = t(1_000);

function hex(tag: string): string {
  return `0x${tag.padStart(64, "0")}`;
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const QUOTE = `${hex("2")}::usdc::USDC`;
const P = {
  open: hex("0be5"),
  ended: hex("e5d"),
  pending: hex("be5d"),
  funded: hex("f5d"),
  cancelled: hex("ca5c"),
  migrated: hex("a1a7"),
} as const;

const W = {
  kai: hex("1a2b00000000000000000009f0e"),
  nova: hex("50fa"),
  ghost: hex("9057"),
  late: hex("1a7e"),
  anon: hex("a505"),
} as const;

const A = { kai: uuid(1), nova: uuid(2), ghost: uuid(3), late: uuid(4) } as const;
const KAI_PROFILE = uuid(0x100);

function presale(id: string, symbol: string, lifecycle: ChainPresaleRow["lifecycle"], endMs: number): ChainPresaleRow {
  return {
    presale_id: id, sale_token: `${id}::coin::${symbol}`, quote_type: QUOTE, sale_symbol: symbol,
    sale_name: symbol.toLowerCase(), sale_icon_url: `https://i/${symbol.toLowerCase()}.png`, sale_decimals: 9,
    quote_symbol: "USDC", quote_decimals: 6, lifecycle, start_ms: t(0), end_ms: endMs, raise_target: "100000000000",
    min_commitment: "1000000", wallet_cap: null, total_commitments: "0", participants: 0, venue: "cetus",
    pool_id: null, updated_checkpoint: 5_000,
  };
}

const PRESALES: readonly ChainPresaleRow[] = [
  presale(P.open, "OPEN", "open", NOW + 86_400_000),
  presale(P.ended, "ENDED", "open", NOW - 1),
  presale(P.pending, "PEND", "pending", NOW + 86_400_000),
  presale(P.funded, "FUND", "funded", t(500)),
  presale(P.cancelled, "CANC", "cancelled", t(500)),
  presale(P.migrated, "MIGR", "migrated", t(500)),
];

let slot = 0;
function act(second: number, kind: string, actor: string, presaleId: string | null, extra: Partial<ChainActivityRow> = {}): ChainActivityRow {
  slot += 1;
  return {
    checkpoint: 5_000 + second, tx_slot: slot, event_slot: 0, part: 0, timestamp_ms: t(second),
    digest: `Dg${second}x${slot}`.padEnd(44, "1"), kind,
    product: kind.startsWith("presale_") ? "presale" : kind.startsWith("launch_") ? "launchpad" : "market",
    actor, tx_sender: actor, presale_id: presaleId, coin_type: null, quote_type: QUOTE, quote_amount: "10000000",
    coin_amount: null, quote_refund: null, usd_value: "10", usd_price_as_of_ms: t(second) - 1_000, venue: null,
    participants_after: null, total_commitments_after: null, ...extra,
  };
}

const ROWS = {
  kaiCommit: act(100, "presale_commit", W.kai, P.open),
  kaiNullUsdCommit: act(101, "presale_commit", W.kai, P.cancelled, { usd_value: null, usd_price_as_of_ms: null }),
  kaiClaim: act(102, "presale_claim", W.kai, P.migrated, {
    quote_amount: "0", coin_amount: "250000000000", quote_refund: "0", usd_value: null, usd_price_as_of_ms: null,
  }),
  kaiLaunchBuy: act(103, "launch_buy", W.kai, null, { usd_value: "3" }),
  novaEndedCommit: act(110, "presale_commit", W.nova, P.ended, { usd_value: "17.505" }),
  novaBigCommit: act(111, "presale_commit", W.nova, P.funded, { usd_value: "5000", quote_amount: "5000000000" }),
  novaBigBuy: act(112, "trade_buy", W.nova, P.migrated, { usd_value: "2500", coin_amount: "900000000000" }),
  ghostBigCommit: act(120, "presale_commit", W.ghost, P.open, { usd_value: "5000", quote_amount: "5000000000" }),
  ghostSmallCommit: act(121, "presale_commit", W.ghost, P.open),
  lateBigCommit: act(130, "presale_commit", W.late, P.pending, { usd_value: "1500" }),
  anonAtThreshold: act(140, "presale_commit", W.anon, P.funded, { usd_value: "1000" }),
  anonNullUsd: act(141, "presale_commit", W.anon, P.funded, { usd_value: null }),
  anonSmallSell: act(142, "trade_sell", W.anon, P.migrated, { usd_value: "999.99" }),
  anonBigSell: act(143, "trade_sell", W.anon, P.migrated, { usd_value: "1200", coin_amount: "40000000000" }),
} as const;
type RowName = keyof typeof ROWS;

const LIFECYCLE: readonly ChainPresaleLifecycleRow[] = [
  { presale_id: P.open, state: "opened", digest: "Lo".padEnd(44, "1"), timestamp_ms: t(10), checkpoint: 5_010 },
  { presale_id: P.ended, state: "opened", digest: "Le".padEnd(44, "1"), timestamp_ms: t(11), checkpoint: 5_011 },
  { presale_id: P.funded, state: "funded", digest: "Lf".padEnd(44, "1"), timestamp_ms: t(150), checkpoint: 5_150 },
  { presale_id: P.cancelled, state: "cancelled", digest: "Lc".padEnd(44, "1"), timestamp_ms: t(151), checkpoint: 5_151 },
  { presale_id: P.migrated, state: "migrated", digest: "Lm".padEnd(44, "1"), timestamp_ms: t(152), checkpoint: 5_152 },
];
const MILESTONE = { presaleId: P.open, kind: "participants", value: "10", at: t(160) } as const;

function id(name: RowName): string {
  const row = ROWS[name];
  return activityEntryId(`${row.checkpoint}:${row.tx_slot}:${row.event_slot}:${row.part}`);
}
const MILESTONE_ID = milestoneEntryId(MILESTONE.presaleId, MILESTONE.kind, MILESTONE.value);
const OPENED_ID = lifecycleEntryId(P.open, "opened");

/** Which rows become items, and whose identity each shows. */
const EXPECTED_ACTOR: Readonly<Record<RowName, "kai" | "nova" | "address" | "dropped">> = {
  kaiCommit: "kai",
  kaiNullUsdCommit: "kai",
  kaiClaim: "kai",
  kaiLaunchBuy: "kai",
  novaEndedCommit: "nova",
  novaBigCommit: "nova",
  novaBigBuy: "nova",
  // Private: a big commit shows the address only; a small one is never shown.
  ghostBigCommit: "address",
  ghostSmallCommit: "dropped",
  // Never onboarded (not sharing): the same.
  lateBigCommit: "address",
  anonAtThreshold: "address",
  anonNullUsd: "dropped",
  anonSmallSell: "dropped",
  anonBigSell: "address",
};

const IDENTITY = {
  // OA-8: Kai is a Mission Control member (signed up with X): verified. Nova's new account has no X subject.
  kai: {
    type: "account", callsign: "kai", display_name: "Kai", avatar_url: "https://cdn.blast.fun/avatars/kai.png", x_handle: "kai_x",
    verified: true, path: "/@kai",
  },
  nova: {
    type: "account", callsign: "nova", display_name: "Nova", avatar_url: "https://pbs.twimg.com/nova.png", x_handle: "nova_x",
    verified: false, path: "/@nova",
  },
} as const;
/** Every identity value of every account, including the private and never-onboarded ones. */
const IDENTITY_VALUES = new Set(["kai", "Kai", "kai_x", "nova", "Nova", "nova_x", "ghost", "Ghost", "ghost_x", "late_one", "Late", "late_x"]);
const IDENTITY_KEYS = new Set(["callsign", "display_name", "avatar_url", "x_handle", "verified", "path"]);

type Fixture = Readonly<{ admin: Pool; replica: ReadableDatabase; web: ReadableDatabase }>;

const POOL = { connectionTimeoutMs: 2_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 500, max: 4, statementTimeoutMs: 5_000 };

async function seed(admin: Pool): Promise<void> {
  await rebuildChainRead(admin, { activity: Object.values(ROWS), presale_lifecycle: LIFECYCLE, presales: PRESALES });
  // Kai is a Mission Control member: identity from the profile.
  await admin.query(
    `INSERT INTO mission_control_profiles (
       profile_id, privy_did, x_subject, x_handle, x_avatar_reference, sui_address, provider_wallet_reference, callsign,
       display_name, avatar_reference, disclosure_version, disclosure_accepted_at
     ) VALUES ($1, 'did:privy:kai', 'x-kai', 'kai_x', 'https://pbs.twimg.com/kai.png', $2, 'wallet-kai', 'kai',
       'Kai', 'https://cdn.blast.fun/avatars/kai.png', 'fixture-v1', now())`,
    [KAI_PROFILE, hex("9001")],
  );
  await admin.query(
    `INSERT INTO social_accounts (account_id, profile_id, privacy, sharing_since, onboarded_at)
     VALUES ($1, $2, 'public', $3, $3)`,
    [A.kai, KAI_PROFILE, new Date(t(0)).toISOString()],
  );
  const accounts: readonly [string, string, string, string, string | null][] = [
    // [account, callsign, display name, privacy, sharing_since]
    [A.nova, "nova", "Nova", "public", new Date(t(0)).toISOString()],
    [A.ghost, "ghost", "Ghost", "private", null],
    [A.late, "late_one", "Late", "public", null],
  ];
  for (const [account, callsign, displayName, privacy, sharingSince] of accounts) {
    await admin.query(
      `INSERT INTO social_accounts (account_id, privy_did, callsign, display_name, x_handle, x_avatar_url, privacy, sharing_since)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [account, `did:privy:${callsign}`, callsign, displayName, callsign === "late_one" ? "late_x" : `${callsign}_x`,
        `https://pbs.twimg.com/${callsign}.png`, privacy, sharingSince],
    );
  }
  for (const [address, account] of [[W.kai, A.kai], [W.nova, A.nova], [W.ghost, A.ghost], [W.late, A.late]]) {
    await admin.query("INSERT INTO social_account_wallets (address, account_id, verified_at) VALUES ($1, $2, $3)", [
      address, account, new Date(t(0)).toISOString(),
    ]);
  }
  await admin.query(
    "INSERT INTO social_milestones (entry_id, presale_id, kind, value, timestamp_ms) VALUES ($1, $2, $3, $4, $5)",
    [MILESTONE_ID, MILESTONE.presaleId, MILESTONE.kind, MILESTONE.value, MILESTONE.at],
  );

  // Whys: active on Kai's commit; on Nova's buy a deleted one then an active one; on the ghost's commit only a removed one.
  await admin.query(
    `INSERT INTO social_whys (why_id, entry_id, author_account_id, text, state, deleted_at, removed_at, removed_by, removal_reason)
     VALUES ($1, $2, $9, 'Team shipped on time twice.', 'active', NULL, NULL, NULL, NULL),
            ($3, $4, $10, 'Deleted reason.', 'deleted', now(), NULL, NULL, NULL),
            ($5, $4, $10, 'Volume is real.', 'active', NULL, NULL, NULL, NULL),
            ($6, $7, $9, 'Removed reason.', 'removed', NULL, now(), 'operator-1', 'spam'),
            ($8, $11, $9, 'Deleted on a lifecycle post.', 'deleted', now(), NULL, NULL, NULL)`,
    [uuid(0xa1), id("kaiCommit"), uuid(0xa2), id("novaBigBuy"), uuid(0xa3), uuid(0xa4), id("ghostBigCommit"), uuid(0xa5),
      A.kai, A.nova, OPENED_ID],
  );
  // Reactions: three fire and one rocket on Kai's commit, plus a key no longer configured.
  await admin.query(
    `INSERT INTO social_reactions (entry_id, account_id, reaction)
     VALUES ($1, $2, 'fire'), ($1, $3, 'fire'), ($1, $4, 'fire'), ($1, $3, 'rocket'), ($1, $2, 'heart'), ($5, $2, 'eyes')`,
    [id("kaiCommit"), A.kai, A.nova, A.ghost, id("anonAtThreshold")],
  );
  // Attributions: Kai's commit led to three, by two accounts, one voided and one without USD.
  const attribution = `INSERT INTO social_attributions
      (tx_digest, entry_id, author_account_id, actor_account_id, action, presale_id, quote_amount, usd_value, occurred_at_ms, voided_at, void_reason)
    VALUES ($1, $2, $3, $4, 'commit', $5, $6, $7, $8, $9, $10)`;
  const rows: readonly [string, string, string | null, string, string, string | null, string | null][] = [
    ["Tx1", id("kaiCommit"), A.kai, A.nova, P.open, "100.004", null],
    ["Tx2", id("kaiCommit"), A.kai, A.ghost, P.open, null, null],
    ["Tx3", id("kaiCommit"), A.kai, A.nova, P.open, "50", "fraud"],
    // Authorless: an address-only post and a lifecycle post still count.
    ["Tx4", id("anonAtThreshold"), null, A.kai, P.funded, "25.5", null],
    ["Tx5", OPENED_ID, null, A.kai, P.open, "10", null],
    ["Tx6", OPENED_ID, null, A.nova, P.open, "0.995", null],
  ];
  for (const [digest, entryId, author, actor, presaleId, usd, voided] of rows) {
    await admin.query(attribution, [
      digest.padEnd(44, "1"), entryId, author, actor, presaleId, "1000000", usd, t(200), voided ? new Date().toISOString() : null, voided,
    ]);
  }
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const database = await freshTestDatabase();
  const { url } = database;
  const admin = createPool(url, { max: 4 });
  await seed(admin);
  const replicaPool = createRuntimePool(urlAs(url, "blast_replica"), POOL, "social-items-replica");
  const webPool = createRuntimePool(urlAs(url, "blast_web"), POOL, "social-items-web");
  try {
    assert.equal((await replicaPool.query("SELECT current_user AS role")).rows[0]?.role, "blast_replica");
    await run({ admin, replica: autocommitReader(replicaPool, "social"), web: autocommitReader(webPool, "social") });
  } finally {
    await Promise.all([admin.end(), replicaPool.end(), webPool.end()]);
    await database.drop();
  }
}

/** Every entry of `social_feed_entries` with its named owner, newest first: the unfiltered input. */
async function everyEntry(db: ReadableDatabase): Promise<FeedEntry[]> {
  const result = await db.read<Parameters<typeof entryFromRow>[0]>(
    `SELECT e.entry_id, e.source, e.kind, e.product, e.occurred_at_ms, e.actor, e.presale_id, e.coin_type, e.digest,
       e.activity_id, e.quote_type, e.quote_amount, e.coin_amount, e.quote_refund, e.usd_value, e.usd_price_as_of_ms,
       e.milestone_value, ${namedOwnerSql("e")} AS named_account_id
     FROM social_feed_entries e
     ORDER BY e.occurred_at_ms DESC, e.entry_id COLLATE "C" DESC`,
  );
  return result.rows.map(entryFromRow);
}

function thresholdsOf(config: SocialConfig): PresalePostThresholds {
  return { bigCommitUsd: config.big_commit_usd, bigTradeUsd: config.big_trade_usd };
}

/** What feeds map: presale posts and every account's named person entries. */
async function selected(db: ReadableDatabase, config: SocialConfig): Promise<FeedEntry[]> {
  const posts = await presalePostEntriesOf(db, "all", thresholdsOf(config), { limit: 200 });
  const people = await personEntriesOf(db, Object.values(A), { limit: 200 });
  const byId = new Map([...posts, ...people].map((entry) => [entry.entryId, entry]));
  return [...byId.values()].sort((a, b) => b.occurredAtMs - a.occurredAtMs || (a.entryId < b.entryId ? 1 : -1));
}

function byEntry(items: readonly FeedItem[]): Map<string, FeedItem> {
  return new Map(items.map((item) => [item.entry_id, item]));
}

/** Every key and string value anywhere in `value`. */
function walk(value: unknown, visit: (key: string | null, leaf: unknown) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      visit(key, child);
      walk(child, visit);
    }
  } else {
    visit(null, value);
  }
}

function assertValid(items: readonly FeedItem[]): void {
  for (const item of items) assert.deepEqual(validator.validate("feed-item", item).errors, [], item.entry_id);
}

test("T-005-AC-1: identity only on named items, a JSON walk finds none on any unnamed item", { skip }, async () => {
  await withFixture(async ({ replica, web }) => {
    for (const db of [replica, web]) {
      const entries = await everyEntry(db);
      assert.equal(entries.length, Object.keys(ROWS).length + LIFECYCLE.length + 1);
      const items = await toItems(db, entries, { nowMs: NOW, config: SOCIAL_CONFIG_DEFAULTS });
      const mapped = byEntry(items);
      const entryById = new Map(entries.map((entry) => [entry.entryId, entry]));
      function assertActorMapping() {
        for (const [name, expected] of Object.entries(EXPECTED_ACTOR) as [RowName, string][]) {
          const item = mapped.get(id(name));
          if (expected === "dropped") {
            assert.equal(item, undefined, name);
          } else if (expected === "address") {
            const address = ROWS[name].actor;
            assert.deepEqual(item?.actor, { type: "address", address, short: `${address.slice(0, 6)}…${address.slice(-4)}` }, name);
            assert.equal(item?.presale_post, true, name);
          } else {
            assert.deepEqual(item?.actor, IDENTITY[expected as "kai" | "nova"], name);
          }
        }
      }
      assertActorMapping();
      // AC-051: the short form of a private account's big commit.
      assert.deepEqual(mapped.get(id("ghostBigCommit"))?.actor, {
        type: "address", address: W.ghost, short: `0x0000…9057`,
      });
      assert.equal(mapped.get(id("ghostBigCommit"))?.big, true);
      // Lifecycle and milestone posts carry no actor.
      for (const entryId of [...LIFECYCLE.map((row) => lifecycleEntryId(row.presale_id, row.state)), MILESTONE_ID]) {
        assert.equal(mapped.get(entryId)?.actor, null, entryId);
        assert.equal(mapped.get(entryId)?.presale_post, true, entryId);
      }
      // The walk: no identity key or value on any item whose entry is not named. A post's backers
      // are the accounts the naming rule names for their own commits (checked below), never the post's actor.
      let unnamed = 0;
      for (const item of items) {
        if (entryById.get(item.entry_id)?.namedAccountId !== null) continue;
        unnamed += 1;
        walk({ ...item, backers: null }, (key, leaf) => {
          assert.ok(key === null || !IDENTITY_KEYS.has(key), `${item.entry_id}: ${key}`);
          assert.ok(typeof leaf !== "string" || (!IDENTITY_VALUES.has(leaf) && !leaf.includes("/@")), `${item.entry_id}: ${String(leaf)}`);
        });
        // Backers come only from named commits: never the private or never-onboarded account.
        for (const backer of item.backers ?? []) assert.ok(["kai", "nova"].includes(backer.callsign), `${item.entry_id}: ${backer.callsign}`);
      }
      assert.equal(unnamed, 4 + LIFECYCLE.length + 1);
      // The feeds' own selections map to the same items.
      assert.deepEqual(await toItems(db, await selected(db, SOCIAL_CONFIG_DEFAULTS), { nowMs: NOW, config: SOCIAL_CONFIG_DEFAULTS }),
        items.filter((item) => item.kind !== "launch_buy"));
      assertValid(items);
    }
  });
});

test("T-005-AC-2: raising big_commit_usd and big_trade_usd turns big and presale_post false on the next mapping", { skip }, async () => {
  await withFixture(async ({ admin, replica }) => {
    const reader = createSocialConfigReader(replica, { ttlMs: 0 });
    const before = await reader.getSocialConfig();
    const first = byEntry(await toItems(replica, await selected(replica, before), { nowMs: NOW, config: before }));
    for (const name of ["novaBigCommit", "novaBigBuy", "ghostBigCommit", "anonBigSell"] as const) {
      assert.deepEqual([first.get(id(name))?.big, first.get(id(name))?.presale_post], [true, true], name);
    }

    await admin.query(
      `INSERT INTO social_config (key, value, updated_by) VALUES ('big_commit_usd', '"5000.01"', 'test'), ('big_trade_usd', '"2500.01"', 'test')`,
    );
    const after = await reader.getSocialConfig();
    assert.deepEqual([after.big_commit_usd, after.big_trade_usd], ["5000.01", "2500.01"]);
    const entries = await everyEntry(replica);
    const second = byEntry(await toItems(replica, entries, { nowMs: NOW, config: after }));
    // Named items stay, no longer big; unnamed ones are no longer posts, so they are not shown at all.
    for (const name of ["novaBigCommit", "novaBigBuy"] as const) {
      assert.deepEqual([second.get(id(name))?.big, second.get(id(name))?.presale_post], [false, false], name);
    }
    for (const name of ["ghostBigCommit", "anonBigSell"] as const) assert.equal(second.has(id(name)), false, name);
    // Below the new threshold the trade from before is not big either; 1500 and 1000 commits are not big now.
    assert.equal(second.has(id("lateBigCommit")), false);
    assert.equal(second.has(id("anonAtThreshold")), false);
    // The selections with the same values agree.
    const posts = await presalePostEntriesOf(replica, "all", thresholdsOf(after), { limit: 200 });
    assert.ok(!posts.some((entry) => entry.entryId === id("novaBigCommit") || entry.entryId === id("ghostBigCommit")));

    await admin.query("UPDATE social_config SET value = '\"1\"' WHERE key = 'big_trade_usd'");
    const lowered = await reader.getSocialConfig();
    const third = byEntry(await toItems(replica, entries, { nowMs: NOW, config: lowered }));
    assert.equal(third.get(id("anonSmallSell"))?.big, true);
    assert.equal(third.get(id("novaBigBuy"))?.big, true);
  });
});

test("T-005-AC-3: amounts.usd is the activity row's usd_value unrounded (at most 12 places), null when null", { skip }, async () => {
  await withFixture(async ({ admin, replica }) => {
    const stored = await admin.query<{ activity_id: string; usd: string | null; quote_amount: string; coin_amount: string | null }>(
      "SELECT activity_id, trim_scale(round(usd_value, 12))::text AS usd, quote_amount::text, coin_amount::text FROM chain_read_v1.activity",
    );
    const items = byEntry(await toItems(replica, await everyEntry(replica), { nowMs: NOW, config: SOCIAL_CONFIG_DEFAULTS }));
    let checked = 0;
    for (const row of stored.rows) {
      const item = items.get(activityEntryId(row.activity_id));
      if (!item) continue;
      checked += 1;
      assert.equal(item.amounts?.usd, row.usd, row.activity_id);
      assert.equal(item.amounts?.quote, row.quote_amount);
      assert.equal(item.amounts?.tokens, row.coin_amount);
      // The presale's quote names the amount; an item without a presale (a launch buy) names none.
      const named = item.presale === null ? [null, null] : ["USDC", 6];
      assert.deepEqual([item.amounts?.quote_symbol, item.amounts?.quote_decimals], named, row.activity_id);
    }
    assert.equal(checked, Object.values(EXPECTED_ACTOR).filter((actor) => actor !== "dropped").length);
    assert.equal(items.get(id("novaEndedCommit"))?.amounts?.usd, "17.505");
    assert.equal(items.get(id("kaiNullUsdCommit"))?.amounts?.usd, null);
    assert.deepEqual(items.get(id("kaiClaim"))?.amounts, {
      quote: "0", quote_symbol: "USDC", quote_decimals: 6, usd: null, tokens: "250000000000", quote_refund: "0",
    });
  });
});

test("T-005-AC-4: through counts distinct accounts over non-voided attributions, authorless posts included", { skip }, async () => {
  await withFixture(async ({ replica }) => {
    const items = byEntry(await toItems(replica, await everyEntry(replica), { nowMs: NOW, config: SOCIAL_CONFIG_DEFAULTS }));
    assert.deepEqual(items.get(id("kaiCommit"))?.through, { people: 2, volume_usd: "100.00" });
    assert.deepEqual(items.get(id("anonAtThreshold"))?.through, { people: 1, volume_usd: "25.50" });
    assert.deepEqual(items.get(OPENED_ID)?.through, { people: 2, volume_usd: "11.00" });
    assert.deepEqual(items.get(id("novaBigCommit"))?.through, { people: 0, volume_usd: "0.00" });

    // Why: only an active one; reactions: configured keys only.
    assert.deepEqual(items.get(id("kaiCommit"))?.why, { why_id: uuid(0xa1), text: "Team shipped on time twice." });
    assert.deepEqual(items.get(id("novaBigBuy"))?.why, { why_id: uuid(0xa3), text: "Volume is real." });
    assert.equal(items.get(id("ghostBigCommit"))?.why, null);
    assert.equal(items.get(OPENED_ID)?.why, null);
    // OA-5: only the rocket is configured; the stored fire, eyes and heart rows are kept but not shown.
    assert.deepEqual(items.get(id("kaiCommit"))?.reactions, { rocket: 1 });
    assert.deepEqual(items.get(id("anonAtThreshold"))?.reactions, { rocket: 0 });
    const narrowed = { ...SOCIAL_CONFIG_DEFAULTS, reactions: ["rocket", "heart"] };
    const again = byEntry(await toItems(replica, await everyEntry(replica), { nowMs: NOW, config: narrowed }));
    assert.deepEqual(again.get(id("kaiCommit"))?.reactions, { rocket: 1, heart: 1 });
  });
});

test("T-005-AC-5: the do-the-same descriptor of items of a presale in each lifecycle", { skip }, async () => {
  await withFixture(async ({ replica }) => {
    const items = byEntry(await toItems(replica, await everyEntry(replica), { nowMs: NOW, config: SOCIAL_CONFIG_DEFAULTS }));
    const commitToo = { kind: "commit", enabled: true, label: "Blast", href: null };
    const view = (presaleId: string, kind = "commit") => ({ kind, enabled: false, label: "View presale", href: `/presale/${presaleId}` });
    const expected: readonly [string, unknown][] = [
      [id("kaiCommit"), commitToo],
      [OPENED_ID, commitToo],
      [MILESTONE_ID, commitToo],
      [id("ghostBigCommit"), commitToo],
      [id("novaEndedCommit"), view(P.ended)],
      [lifecycleEntryId(P.ended, "opened"), view(P.ended)],
      [id("lateBigCommit"), view(P.pending)],
      [id("novaBigCommit"), view(P.funded)],
      [lifecycleEntryId(P.funded, "funded"), view(P.funded)],
      [id("kaiNullUsdCommit"), view(P.cancelled)],
      [lifecycleEntryId(P.cancelled, "cancelled"), view(P.cancelled)],
      [id("kaiClaim"), view(P.migrated)],
      [lifecycleEntryId(P.migrated, "migrated"), view(P.migrated)],
      [id("novaBigBuy"), view(P.migrated, "buy")],
      [id("anonBigSell"), view(P.migrated, "buy")],
      [id("kaiLaunchBuy"), null],
    ];
    for (const [entryId, descriptor] of expected) assert.deepEqual(items.get(entryId)?.do_the_same, descriptor, entryId);
    // The same open sale stops taking commits once its end passes.
    const later = byEntry(await toItems(replica, await everyEntry(replica), { nowMs: NOW + 86_400_000, config: SOCIAL_CONFIG_DEFAULTS }));
    assert.deepEqual(later.get(id("kaiCommit"))?.do_the_same, view(P.open));
    assert.deepEqual(items.get(id("kaiCommit"))?.presale, {
      presale_id: P.open, coin_type: `${P.open}::coin::OPEN`, symbol: "OPEN", name: "open", icon_url: "https://i/open.png", lifecycle: "open", decimals: 9,
      venue: "cetus", start_ms: t(0), end_ms: NOW + 86_400_000, raise_target: "100000000000", raised: "0", participants: 0,
      quote_symbol: "USDC", quote_decimals: 6, quote_usd: null, market: null,
    });
    // A migrated presale has a market; without prices or an allocation it is all null (OA-9).
    assert.deepEqual(items.get(id("kaiClaim"))?.presale?.market, { presale_price_usd: null, price_usd: null, price_as_of_ms: null, multiple: null });
  });
});

test("T-005-AC-6: paging by cursor walks a selection exactly once; a tampered cursor is invalid_parameter", { skip }, async () => {
  await withFixture(async ({ replica }) => {
    const thresholds = thresholdsOf(SOCIAL_CONFIG_DEFAULTS);
    const all = await presalePostEntriesOf(replica, "all", thresholds, { limit: 200 });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const before = cursor === null ? null : decodeItemCursor(cursor);
      const page = await presalePostEntriesOf(replica, "all", thresholds, { limit: 3, before });
      seen.push(...(await toItems(replica, page, { nowMs: NOW, config: SOCIAL_CONFIG_DEFAULTS })).map((item) => item.entry_id));
      cursor = nextItemCursor(page, 3);
      pages += 1;
    } while (cursor !== null && pages < 20);
    assert.deepEqual(seen, all.map((entry) => entry.entryId));
    assert.equal(pages, Math.floor(all.length / 3) + 1);
    const last = nextItemCursor(all.slice(0, 3), 3);
    assert.ok(last);
    assert.throws(() => decodeItemCursor(`${last.slice(0, -1)}${last.endsWith("A") ? "B" : "A"}`), (error: unknown) =>
      error instanceof SocialRouteError && error.code === "invalid_parameter");
  });
});

test("T-005-AC-7: the published schema validates every mapped fixture item, launch_buy included", { skip }, async () => {
  await withFixture(async ({ replica }) => {
    const items = await toItems(replica, await everyEntry(replica), { nowMs: NOW, config: SOCIAL_CONFIG_DEFAULTS });
    assertValid(items);
    const kinds = new Set(items.map((item) => item.kind));
    for (const kind of ["presale_commit", "presale_claim", "trade_buy", "trade_sell", "launch_buy", "presale_opened",
      "presale_funded", "presale_cancelled", "presale_migrated", "milestone_participants"]) {
      assert.ok(kinds.has(kind), kind);
    }
    const launch = items.find((item) => item.kind === "launch_buy");
    assert.deepEqual([launch?.presale, launch?.do_the_same, launch?.big, launch?.presale_post], [null, null, false, false]);
    const milestone = items.find((item) => item.entry_id === MILESTONE_ID);
    assert.deepEqual([milestone?.milestone_value, milestone?.amounts, milestone?.digest], ["10", null, null]);
  });
});

test("as_of: the slowest pipeline's checkpoint and timestamp from chain_read_v1.watermark", { skip }, async () => {
  await withFixture(async ({ admin, replica }) => {
    await admin.query(advanceWatermark(9_000, 1_000, "market"));
    await admin.query(advanceWatermark(8_500, 60_000, "presale"));
    const asOf = await readAsOf(replica);
    assert.ok(asOf);
    assert.equal(asOf.checkpoint, 8_500);
    assert.ok(asOf.lag_ms >= 60_000 && asOf.lag_ms < 70_000, String(asOf.lag_ms));
    assert.deepEqual(validator.validate("as-of", asOf).errors, []);
    await admin.query(advanceWatermark(9_500, 120_000, "market"));
    assert.equal((await readAsOf(replica))?.checkpoint, 9_500);
    // A pipeline whose readable range is empty has no position: freshness unknown.
    await admin.query("UPDATE watermarks SET reader_lo = checkpoint_hi_inclusive + 1 WHERE pipeline = 'presale'");
    assert.equal(await readAsOf(replica), null);
  });
});
