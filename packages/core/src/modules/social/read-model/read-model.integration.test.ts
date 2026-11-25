import { PUBLIC_ACTIVITY, PUBLIC_FEED_ENTRIES, SHOWN_PRESALES, SHOWN_ACTIVITY, SHOWN_FEED_ENTRIES, liveSaleSql } from "./chain-presales.ts";
import { CREATE_TEST_SUI_QUOTE_TYPE } from "../contracts/create.ts";
import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import {
  CHAIN_READ_ROWS,
  FIXTURE_CANCELLED_PRESALE_ID,
  FIXTURE_PRESALE_ID,
  FIXTURE_QUOTE_TYPE,
  FIXTURE_SALE_COIN_TYPE,
  FIXTURE_WALLETS,
  rebuildChainRead,
  type ChainActivityRow,
  type ChainPresaleLifecycleRow,
} from "../../../../test/fixtures/modules/database/chain-read-rows.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase, type TestDatabase } from "../../../../test/fixtures/modules/database/template.ts";
import { autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { activityEntryId, lifecycleEntryId, milestoneEntryId } from "../contracts/feed-entries.ts";
import { namedOwnerSql } from "./naming.ts";
import {
  isVisible,
  personEntriesOf,
  presalePostEntriesOf,
  type EntryWindow,
  type FeedEntry,
  type PresalePostThresholds,
} from "./entries.ts";

/**
 * Social feed T-004: the naming rule and the entry selections on a disposable
 * database with blast-infra's fixture `chain_read_v1`. One matrix of accounts
 * in every sharing state, wallets linked at varied times and activity,
 * lifecycle and milestone rows; every read runs as the web runtime role.
 */
const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";

const THRESHOLDS: PresalePostThresholds = { bigCommitUsd: "250", bigTradeUsd: "1000" };
const PAGE: EntryWindow = { limit: 200 };
const P1 = FIXTURE_PRESALE_ID;
const P2 = FIXTURE_CANCELLED_PRESALE_ID;

/** The matrix's clock: second `n` after a fixed origin, in milliseconds. */
function t(n: number): number {
  return 1_790_000_000_000 + n * 1_000;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function wallet(tag: string): string {
  return `0x${tag.padStart(64, "0")}`;
}

/** Wallets of the matrix, one per account state, plus a wallet nobody owns and a relayer. */
const W = {
  never: wallet("e0e7"),
  sharing: wallet("5a7e"),
  private: wallet("971a7e"),
  again: wallet("a9a17"),
  late: wallet("1a7e"),
  halfMs: wallet("4a1f"),
  relayer: wallet("7e1a1e7"),
  unowned: wallet("dead"),
} as const;

/** Accounts: never onboarded, sharing, private, public again, linked late, sharing half a millisecond late, relayer. */
const A = {
  never: uuid(1),
  sharing: uuid(2),
  private: uuid(3),
  again: uuid(4),
  late: uuid(5),
  halfMs: uuid(6),
  relayer: uuid(7),
} as const;

let slot = 0;
function act(
  second: number,
  kind: string,
  actor: string,
  extra: Partial<ChainActivityRow> = {},
): ChainActivityRow {
  slot += 1;
  return {
    checkpoint: 5_000 + second,
    tx_slot: slot,
    event_slot: 0,
    part: 0,
    timestamp_ms: t(second),
    digest: `Mx${second}x${slot}`.padEnd(44, "1"),
    kind,
    product: kind.startsWith("presale_") ? "presale" : kind.startsWith("launch_") ? "launchpad" : "market",
    actor,
    tx_sender: actor,
    presale_id: P1,
    coin_type: FIXTURE_SALE_COIN_TYPE,
    quote_type: FIXTURE_QUOTE_TYPE,
    quote_amount: "1000000000",
    coin_amount: null,
    quote_refund: null,
    usd_value: "10",
    usd_price_as_of_ms: t(second) - 1_000,
    venue: null,
    participants_after: null,
    total_commitments_after: null,
    ...extra,
  };
}

function id(row: ChainActivityRow): string {
  return activityEntryId(`${row.checkpoint}:${row.tx_slot}:${row.event_slot}:${row.part}`);
}

/** The matrix's rows, each with the account the rule names it for (null: not named). */
const ROWS = {
  // Never onboarded: sharing_since is null, so nothing is ever named.
  neverCommit: act(10, "presale_commit", W.never),
  neverBigCommit: act(30, "presale_commit", W.never, { usd_value: "900" }),
  // Sharing since t(20): before is not named, at and after are.
  sharingBefore: act(10, "presale_commit", W.sharing),
  sharingAt: act(20, "presale_commit", W.sharing),
  sharingAfter: act(30, "presale_commit", W.sharing),
  sharingSell: act(40, "trade_sell", W.sharing, { product: "market", usd_value: "5", coin_amount: "40000000000" }),
  sharingLaunchBuy: act(42, "launch_buy", W.sharing, { presale_id: null }),
  // A relayer submits the claim: the participant is the actor, the relayer only the tx sender.
  sharingRelayedClaim: act(44, "presale_claim", W.sharing, {
    tx_sender: W.relayer, quote_amount: "0", coin_amount: "250000000000", quote_refund: "0", usd_value: null,
  }),
  relayerOwnCommit: act(46, "presale_commit", W.relayer),
  // Private: nothing is named, before or after.
  privateCommit: act(10, "presale_commit", W.private),
  privateLater: act(30, "presale_commit", W.private, { presale_id: P2 }),
  // Public again from t(50) after sharing from t(5) and a private stretch: only t(50) onward is named.
  againFirstShare: act(10, "presale_commit", W.again),
  againWhilePrivate: act(45, "presale_commit", W.again),
  againAt: act(50, "presale_commit", W.again),
  againBuy: act(60, "trade_buy", W.again, { usd_value: "2500", product: "market" }),
  // Sharing since t(0), wallet linked at t(35): commits before the link are not named.
  lateBeforeLink: act(30, "presale_commit", W.late),
  lateAtLink: act(35, "presale_commit", W.late),
  lateAfterLink: act(40, "presale_commit", W.late),
  // sharing_since is half a millisecond after the commit.
  halfMsCommit: act(80, "presale_commit", W.halfMs),
  // Nobody owns this wallet.
  unownedBigCommit: act(25, "presale_commit", W.unowned, { usd_value: "250" }),
  unownedSmallCommit: act(26, "presale_commit", W.unowned, { usd_value: "249.99" }),
  unownedBigSell: act(27, "trade_sell", W.unowned, { usd_value: "1000", product: "market" }),
  unownedSmallBuy: act(28, "trade_buy", W.unowned, { usd_value: "999.99", product: "market" }),
  unownedNoPriceCommit: act(29, "presale_commit", W.unowned, { usd_value: null }),
} as const;

const EXPECTED_NAMED: Readonly<Record<keyof typeof ROWS, string | null>> = {
  neverCommit: null,
  neverBigCommit: null,
  sharingBefore: null,
  sharingAt: A.sharing,
  sharingAfter: A.sharing,
  sharingSell: A.sharing,
  sharingLaunchBuy: A.sharing,
  sharingRelayedClaim: A.sharing,
  relayerOwnCommit: A.relayer,
  privateCommit: null,
  privateLater: null,
  againFirstShare: null,
  againWhilePrivate: null,
  againAt: A.again,
  againBuy: A.again,
  lateBeforeLink: null,
  lateAtLink: A.late,
  lateAfterLink: A.late,
  halfMsCommit: null,
  unownedBigCommit: null,
  unownedSmallCommit: null,
  unownedBigSell: null,
  unownedSmallBuy: null,
  unownedNoPriceCommit: null,
};

const LIFECYCLE: readonly ChainPresaleLifecycleRow[] = [
  { presale_id: P1, state: "opened", digest: "Lo1".padEnd(44, "1"), timestamp_ms: t(1), checkpoint: 5_001 },
  { presale_id: P1, state: "funded", digest: "Lf1".padEnd(44, "1"), timestamp_ms: t(48), checkpoint: 5_048 },
  { presale_id: P2, state: "opened", digest: "Lo2".padEnd(44, "1"), timestamp_ms: t(2), checkpoint: 5_002 },
  { presale_id: P2, state: "cancelled", digest: "Lc2".padEnd(44, "1"), timestamp_ms: t(55), checkpoint: 5_055 },
];
const MILESTONES = [
  { presaleId: P1, kind: "participants", value: "5", at: t(31) },
  { presaleId: P1, kind: "raise", value: "100", at: t(49) },
] as const;
const MILESTONE_IDS = MILESTONES.map((m) => milestoneEntryId(m.presaleId, m.kind, m.value));
const LIFECYCLE_IDS = LIFECYCLE.map((row) => lifecycleEntryId(row.presale_id, row.state));

type Fixture = Readonly<{ database: TestDatabase; admin: Pool; web: Pool; db: ReadableDatabase }>;

/** A migrated database of the test's own holding the matrix, and a reader as the web runtime role. */
async function matrix(): Promise<Fixture> {
  const database = await freshTestDatabase();
  const admin = createPool(database.url, { max: 4 });
  // The matrix's two sales are in `chain_read_v1.presales` with their coin metadata: the selections keep only entries
  // of sales the web shows (T-043's hidden sales, 2026-10-05).
  await rebuildChainRead(admin, { activity: Object.values(ROWS), presale_lifecycle: LIFECYCLE, presales: CHAIN_READ_ROWS.presales });

  const accounts: readonly [string, string, string, string | null, number | null][] = [
    // [account, callsign, privacy, sharing_since, onboarded_at]
    [A.never, "never_onboarded", "public", null, null],
    [A.sharing, "sharing_now", "public", iso(t(20)), t(20)],
    [A.private, "gone_private", "private", null, t(5)],
    [A.again, "public_again", "public", iso(t(50)), t(5)],
    [A.late, "linked_late", "public", iso(t(0)), t(0)],
    [A.halfMs, "half_ms", "public", iso(t(80)).replace(/Z$/, "500Z"), t(0)],
    [A.relayer, "relayer_acct", "public", iso(t(0)), t(0)],
  ];
  for (const [account, callsign, privacy, sharingSince, onboardedAt] of accounts) {
    await admin.query(
      `INSERT INTO social_accounts (account_id, privy_did, callsign, privacy, sharing_since, onboarded_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [account, `did:privy:${callsign}`, callsign, privacy, sharingSince, onboardedAt === null ? null : iso(onboardedAt)],
    );
  }
  const links: readonly [string, string, number][] = [
    [W.never, A.never, t(0)],
    [W.sharing, A.sharing, t(0)],
    [W.private, A.private, t(0)],
    [W.again, A.again, t(0)],
    [W.late, A.late, t(35)],
    [W.halfMs, A.halfMs, t(0)],
    [W.relayer, A.relayer, t(0)],
  ];
  for (const [address, account, linkedAt] of links) {
    await admin.query("INSERT INTO social_account_wallets (address, account_id, verified_at) VALUES ($1, $2, $3)", [
      address, account, iso(linkedAt),
    ]);
  }
  for (const m of MILESTONES) {
    await admin.query(
      "INSERT INTO social_milestones (entry_id, presale_id, kind, value, timestamp_ms) VALUES ($1, $2, $3, $4, $5)",
      [milestoneEntryId(m.presaleId, m.kind, m.value), m.presaleId, m.kind, m.value, m.at],
    );
  }

  const web = createRuntimePool(urlAs(database.url, "blast_web"), {
    connectionTimeoutMs: 2_000,
    idleInTransactionMs: 5_000,
    idleTimeoutMs: 1_000,
    lockTimeoutMs: 500,
    max: 2,
    statementTimeoutMs: 5_000,
  }, "blast-web");
  return { database, admin, web, db: autocommitReader(web, "social") };
}

async function withMatrix(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const fixture = await matrix();
  try {
    assert.equal((await fixture.web.query("SELECT current_user AS role")).rows[0]?.role, "blast_web");
    await run(fixture);
  } finally {
    await Promise.all([fixture.admin.end(), fixture.web.end()]);
    await fixture.database.drop();
  }
}

/** Every entry's named owner now, through `namedOwnerSql`. */
async function namedOwners(db: ReadableDatabase): Promise<Map<string, string | null>> {
  const result = await db.read<{ entry_id: string; owner: string | null }>(
    `SELECT e.entry_id, ${namedOwnerSql("e")} AS owner FROM social_feed_entries e`,
  );
  return new Map(result.rows.map((row) => [row.entry_id, row.owner]));
}

function ids(entries: readonly FeedEntry[]): string[] {
  return entries.map((entry) => entry.entryId);
}

/** The read model's order: newest first, then entry id descending, bytewise. */
function ordered(entries: readonly { id: string; at: number }[]): string[] {
  return [...entries]
    .sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .map((entry) => entry.id);
}

function rowsOf(names: readonly (keyof typeof ROWS)[]): string[] {
  return ordered(names.map((name) => ({ id: id(ROWS[name]), at: ROWS[name].timestamp_ms })));
}

const NAMES = Object.keys(ROWS) as (keyof typeof ROWS)[];
const PERSON_KINDS = new Set(["presale_commit", "presale_claim", "trade_buy", "trade_sell"]);

test("T-004-AC-1: accounts in every sharing state are named exactly per the rule", { skip }, async () => {
  await withMatrix(async ({ db }) => {
    const owners = await namedOwners(db);
    for (const name of NAMES) {
      assert.equal(owners.get(id(ROWS[name])), EXPECTED_NAMED[name], name);
    }
    // Lifecycle and milestone entries have no actor and are never named.
    for (const entryId of [...LIFECYCLE_IDS, ...MILESTONE_IDS]) assert.equal(owners.get(entryId), null, entryId);
    assert.equal(owners.size, NAMES.length + LIFECYCLE_IDS.length + MILESTONE_IDS.length);
  });
});

test("T-004-AC-1: going private, going public again and onboarding take effect on the next read", { skip }, async () => {
  await withMatrix(async ({ admin, db }) => {
    const sharingNamed = rowsOf(["sharingRelayedClaim", "sharingSell", "sharingAfter", "sharingAt"]);
    assert.deepEqual(ids(await personEntriesOf(db, [A.sharing], PAGE)), sharingNamed);
    assert.equal(await isVisible(db, id(ROWS.sharingAfter), THRESHOLDS), true);

    // AC-024: going private hides every item at once, including those shared before.
    await admin.query("UPDATE social_accounts SET privacy = 'private', sharing_since = NULL WHERE account_id = $1", [A.sharing]);
    assert.deepEqual(ids(await personEntriesOf(db, [A.sharing], PAGE)), []);
    assert.equal(await isVisible(db, id(ROWS.sharingAfter), THRESHOLDS), false);
    for (const name of ["sharingAt", "sharingAfter", "sharingSell", "sharingRelayedClaim"] as const) {
      assert.equal((await namedOwners(db)).get(id(ROWS[name])), null, name);
    }

    // Public again at t(43): items while private, or before, never become named.
    await admin.query("UPDATE social_accounts SET privacy = 'public', sharing_since = $2 WHERE account_id = $1", [A.sharing, iso(t(43))]);
    assert.deepEqual(ids(await personEntriesOf(db, [A.sharing], PAGE)), rowsOf(["sharingRelayedClaim"]));
    assert.equal(await isVisible(db, id(ROWS.sharingAfter), THRESHOLDS), false);

    // AC-023: the never-onboarded member is named only from onboarding completion on.
    assert.deepEqual(ids(await personEntriesOf(db, [A.never], PAGE)), []);
    await admin.query("UPDATE social_accounts SET onboarded_at = $2, sharing_since = $2 WHERE account_id = $1", [A.never, iso(t(30))]);
    assert.deepEqual(ids(await personEntriesOf(db, [A.never], PAGE)), rowsOf(["neverBigCommit"]));
    assert.equal((await namedOwners(db)).get(id(ROWS.neverCommit)), null);
  });
});

test("T-004-AC-2: a commit before the wallet's linked_at is not named; the later commit is", { skip }, async () => {
  await withMatrix(async ({ db }) => {
    const owners = await namedOwners(db);
    assert.equal(owners.get(id(ROWS.lateBeforeLink)), null);
    assert.equal(owners.get(id(ROWS.lateAtLink)), A.late);
    assert.equal(owners.get(id(ROWS.lateAfterLink)), A.late);
    assert.deepEqual(ids(await personEntriesOf(db, [A.late], PAGE)), rowsOf(["lateAfterLink", "lateAtLink"]));
    assert.equal(await isVisible(db, id(ROWS.lateBeforeLink), THRESHOLDS), false);
    assert.equal(await isVisible(db, id(ROWS.lateAfterLink), THRESHOLDS), true);
  });
});

test("T-004-AC-3: every commit, claim and lifecycle row is an entry with its id; a claim's actor is the participant", { skip }, async () => {
  await withMatrix(async ({ admin, db }) => {
    const relayed: ChainActivityRow = {
      ...CHAIN_READ_ROWS.activity[3],
      checkpoint: 1_101,
      timestamp_ms: CHAIN_READ_ROWS.activity[3].timestamp_ms + 1_000,
      actor: FIXTURE_WALLETS.bob,
      tx_sender: W.relayer,
    };
    const activity = [...CHAIN_READ_ROWS.activity, relayed];
    await rebuildChainRead(admin, { ...CHAIN_READ_ROWS, activity });
    await admin.query("INSERT INTO social_account_wallets (address, account_id, verified_at) VALUES ($1, $2, $3)", [
      FIXTURE_WALLETS.bob, A.again, iso(t(0)),
    ]);
    await admin.query("UPDATE social_accounts SET sharing_since = $2 WHERE account_id = $1", [A.again, iso(t(0))]);

    const entries = await db.read<{
      entry_id: string; source: string; kind: string; occurred_at_ms: string; actor: string | null; digest: string;
    }>("SELECT entry_id, source, kind, occurred_at_ms, actor, digest FROM social_feed_entries WHERE source <> 'milestone'");
    const byId = new Map(entries.rows.map((row) => [row.entry_id, row]));
    const people = activity.filter((row) => row.kind === "presale_commit" || row.kind === "presale_claim");
    assert.equal(people.filter((row) => row.kind === "presale_claim").length, 2);
    for (const row of people) {
      const entry = byId.get(id(row));
      assert.ok(entry, `${row.kind} at ${row.checkpoint} is an entry`);
      assert.deepEqual(
        [entry.source, entry.kind, Number(entry.occurred_at_ms), entry.actor, entry.digest],
        ["activity", row.kind, row.timestamp_ms, row.actor, row.digest],
      );
    }
    // AC-039: one entry per lifecycle row, with its own time and digest.
    for (const row of CHAIN_READ_ROWS.presale_lifecycle) {
      const entry = byId.get(lifecycleEntryId(row.presale_id, row.state));
      assert.ok(entry, `${row.presale_id} ${row.state} is an entry`);
      assert.deepEqual(
        [entry.source, entry.kind, Number(entry.occurred_at_ms), entry.actor, entry.digest],
        ["lifecycle", `presale_${row.state}`, row.timestamp_ms, null, row.digest],
      );
    }
    assert.equal(entries.rows.length, activity.length + CHAIN_READ_ROWS.presale_lifecycle.length);

    // AC-038: the relayed claim names the participant's account; the relayer's account gets nothing from it.
    const claimId = id(relayed);
    assert.equal(byId.get(claimId)?.actor, FIXTURE_WALLETS.bob);
    assert.equal((await namedOwners(db)).get(claimId), A.again);
    assert.ok(ids(await personEntriesOf(db, [A.again], PAGE)).includes(claimId));
    assert.ok(!ids(await personEntriesOf(db, [A.relayer], PAGE)).includes(claimId));
  });
});

test("T-004-AC-4: person selections hold only named entries; post selections hold big items and every lifecycle and milestone entry", { skip }, async () => {
  await withMatrix(async ({ db }) => {
    const accounts = Object.values(A);
    const people = await personEntriesOf(db, accounts, PAGE);
    const expectedPeople = NAMES.filter((name) => EXPECTED_NAMED[name] !== null && PERSON_KINDS.has(ROWS[name].kind));
    assert.deepEqual(ids(people), rowsOf(expectedPeople));
    for (const entry of people) {
      assert.ok(entry.namedAccountId && (accounts as readonly string[]).includes(entry.namedAccountId), entry.entryId);
    }
    // Per account, only that account's named entries.
    for (const account of accounts) {
      const own = expectedPeople.filter((name) => EXPECTED_NAMED[name] === account);
      assert.deepEqual(ids(await personEntriesOf(db, [account], PAGE)), rowsOf(own), account);
    }
    // A named entry of a kind that is not a person kind is not a person entry.
    assert.ok(!ids(people).includes(id(ROWS.sharingLaunchBuy)));
    assert.equal(await isVisible(db, id(ROWS.sharingLaunchBuy), THRESHOLDS), false);

    const posts = await presalePostEntriesOf(db, "all", THRESHOLDS, PAGE);
    const bigNames = ["neverBigCommit", "againBuy", "unownedBigCommit", "unownedBigSell"] as const;
    assert.deepEqual(
      ids(posts),
      ordered([
        ...bigNames.map((name) => ({ id: id(ROWS[name]), at: ROWS[name].timestamp_ms })),
        ...LIFECYCLE.map((row) => ({ id: lifecycleEntryId(row.presale_id, row.state), at: row.timestamp_ms })),
        ...MILESTONES.map((m, index) => ({ id: MILESTONE_IDS[index], at: m.at })),
      ]),
    );
    const named = new Map(posts.map((entry) => [entry.entryId, entry.namedAccountId]));
    assert.equal(named.get(id(ROWS.unownedBigCommit)), null, "a big commit by an unnamed wallet is a post");
    assert.equal(named.get(id(ROWS.neverBigCommit)), null, "a never-onboarded member's big commit shows the address only");
    assert.equal(named.get(id(ROWS.againBuy)), A.again);

    // By presale: P2 has only its lifecycle (its commit is small and private).
    assert.deepEqual(
      ids(await presalePostEntriesOf(db, [P2], THRESHOLDS, PAGE)),
      [lifecycleEntryId(P2, "cancelled"), lifecycleEntryId(P2, "opened")],
    );
    assert.deepEqual(await presalePostEntriesOf(db, [], THRESHOLDS, PAGE), []);
    assert.deepEqual(await personEntriesOf(db, [], PAGE), []);

    // isVisible: named or a presale post.
    const expectVisible: Record<string, boolean> = {
      [id(ROWS.sharingAt)]: true,
      [id(ROWS.sharingBefore)]: false,
      [id(ROWS.privateCommit)]: false,
      [id(ROWS.unownedSmallCommit)]: false,
      [id(ROWS.unownedBigCommit)]: true,
      [id(ROWS.unownedSmallBuy)]: false,
      [id(ROWS.unownedBigSell)]: true,
      [id(ROWS.unownedNoPriceCommit)]: false,
      [id(ROWS.halfMsCommit)]: false,
      [lifecycleEntryId(P1, "funded")]: true,
      [MILESTONE_IDS[0]]: true,
      [lifecycleEntryId(P1, "migrated")]: false,
      [milestoneEntryId(P1, "holders", "1")]: false,
      "a:999999:0:0:0": false,
      "x:nothing": false,
    };
    for (const [entryId, visible] of Object.entries(expectVisible)) {
      assert.equal(await isVisible(db, entryId, THRESHOLDS), visible, entryId);
    }
  });
});

test("T-004-AC-5: a sharing account's trade_sell is a named person entry", { skip }, async () => {
  await withMatrix(async ({ db }) => {
    const [sell] = (await personEntriesOf(db, [A.sharing], PAGE)).filter((entry) => entry.kind === "trade_sell");
    assert.ok(sell);
    assert.deepEqual(
      { entryId: sell.entryId, actor: sell.actor, namedAccountId: sell.namedAccountId, occurredAtMs: sell.occurredAtMs, coinAmount: sell.coinAmount },
      { entryId: id(ROWS.sharingSell), actor: W.sharing, namedAccountId: A.sharing, occurredAtMs: t(40), coinAmount: "40000000000" },
    );
    assert.equal(await isVisible(db, sell.entryId, THRESHOLDS), true);
  });
});

test("a named trade under $1 is not a person entry; a $1 trade and an unpriced one are", { skip }, async () => {
  await withMatrix(async ({ admin, db }) => {
    const dust = act(90, "trade_buy", W.sharing, { usd_value: "0.0001", product: "market" });
    const dollar = act(91, "trade_sell", W.sharing, { usd_value: "1", product: "market" });
    const unpriced = act(92, "trade_buy", W.sharing, { usd_value: null, product: "market" });
    await rebuildChainRead(admin, { activity: [dust, dollar, unpriced], presales: CHAIN_READ_ROWS.presales });
    const entries = (await personEntriesOf(db, [A.sharing], PAGE)).map((entry) => entry.entryId);
    assert.deepEqual(entries, [id(unpriced), id(dollar)]);
    assert.equal(await isVisible(db, id(dust), THRESHOLDS), false);
    assert.equal(await isVisible(db, id(dollar), THRESHOLDS), true);
  });
});

test("T-004: windows page by keyset in occurred_at_ms then entry_id order", { skip }, async () => {
  await withMatrix(async ({ admin, db }) => {
    // Two parts of one transaction share a time: entry_id breaks the tie.
    const split = [
      act(70, "trade_sell", W.late, { tx_slot: 900, event_slot: 1, part: 0 }),
      act(70, "trade_sell", W.late, { tx_slot: 900, event_slot: 1, part: 1 }),
    ];
    await rebuildChainRead(admin, { activity: [...Object.values(ROWS), ...split], presale_lifecycle: LIFECYCLE, presales: CHAIN_READ_ROWS.presales });
    const all = ids(await personEntriesOf(db, [A.late], PAGE));
    assert.deepEqual(all, [id(split[1]), id(split[0]), ...rowsOf(["lateAfterLink", "lateAtLink"])]);

    const pages: string[] = [];
    let before: FeedEntry | undefined;
    for (;;) {
      const page = await personEntriesOf(db, [A.late], {
        limit: 1,
        before: before ? { occurredAtMs: before.occurredAtMs, entryId: before.entryId } : null,
      });
      if (page.length === 0) break;
      pages.push(...ids(page));
      before = page.at(-1);
    }
    assert.deepEqual(pages, all);
    assert.deepEqual(ids(await personEntriesOf(db, [A.late], { limit: 200, sinceMs: t(40) })), all.slice(0, 3));

    const posts = ids(await presalePostEntriesOf(db, [P1], THRESHOLDS, PAGE));
    const firstTwo = await presalePostEntriesOf(db, [P1], THRESHOLDS, { limit: 2 });
    const rest = await presalePostEntriesOf(db, [P1], THRESHOLDS, {
      limit: 200,
      before: { occurredAtMs: firstTwo[1].occurredAtMs, entryId: firstTwo[1].entryId },
    });
    assert.deepEqual([...ids(firstTwo), ...ids(rest)], posts);
  });
});

test("public activity and feed pages also drop test markets before pagination, including unstamped trades", { skip }, async () => {
  await withMatrix(async ({ admin, db }) => {
    const hiddenId = wallet("797");
    const incompleteId = wallet("798");
    const incompleteCoin = `${wallet("798")}::coin::COIN`;
    const testId = wallet("799");
    const testCoin = `${testId}::coin::COIN`;
    const visible = act(90, "trade_buy", W.sharing, { presale_id: null, usd_value: "1200" });
    const excluded = act(100, "presale_commit", W.sharing, { presale_id: hiddenId });
    const incomplete = act(101, "trade_buy", W.sharing, { presale_id: null, coin_type: incompleteCoin });
    const testTrade = act(102, "trade_buy", W.sharing, { presale_id: null, coin_type: testCoin });
    const testCommit = act(103, "presale_commit", W.sharing, { presale_id: testId });
    const missingQuote = { ...CHAIN_READ_ROWS.presales[0], presale_id: incompleteId, sale_token: incompleteCoin, quote_symbol: null, quote_decimals: null };
    const testSale = { ...CHAIN_READ_ROWS.presales[0], presale_id: testId, sale_token: testCoin, quote_type: CREATE_TEST_SUI_QUOTE_TYPE, quote_symbol: "TEST SUI" };
    await rebuildChainRead(admin, { activity: [visible, excluded, incomplete, testTrade, testCommit], presales: [...CHAIN_READ_ROWS.presales, missingQuote, testSale] });
    for (const [activitySource, feedSource, newest] of [
      [PUBLIC_ACTIVITY, PUBLIC_FEED_ENTRIES, visible],
      [SHOWN_ACTIVITY, SHOWN_FEED_ENTRIES, testCommit],
    ] as const) {
      const activity = await db.read<{ activity_id: string }>(`SELECT activity_id FROM ${activitySource} a ORDER BY a.timestamp_ms DESC LIMIT 1`);
      assert.deepEqual(activity.rows, [{ activity_id: id(newest).slice(2) }]);
      const entries = await db.read<{ entry_id: string }>(`SELECT entry_id FROM ${feedSource} e WHERE source = 'activity' ORDER BY occurred_at_ms DESC LIMIT 1`);
      assert.deepEqual(entries.rows, [{ entry_id: id(newest) }]);
    }
    assert.equal(await isVisible(db, id(excluded), THRESHOLDS), false);
    assert.equal(await isVisible(db, id(incomplete), THRESHOLDS), false);
    assert.equal(await isVisible(db, id(visible), THRESHOLDS), true);
  });
});

test("shown sales require every display field and lifecycle SQL accepts the caller's alias", { skip }, async () => {
  await withMatrix(async ({ admin, db }) => {
    const base = CHAIN_READ_ROWS.presales[0];
    await rebuildChainRead(admin, { presales: [
      { ...base, presale_id: wallet("10"), sale_decimals: null, sale_symbol: null, sale_name: null, sale_icon_url: null },
      { ...base, presale_id: wallet("11"), quote_decimals: null, quote_symbol: null },
      { ...base, presale_id: wallet("13"), venue: null },
      { ...base, presale_id: wallet("14"), lifecycle: "open", start_ms: 10, end_ms: 20 },
    ] });
    assert.deepEqual((await db.read(`SELECT presale_id FROM ${SHOWN_PRESALES}`)).rows, [{ presale_id: wallet("14") }]);
    assert.deepEqual((await db.read(`SELECT presale_id FROM ${SHOWN_PRESALES} sale WHERE ${liveSaleSql("sale", "10")}`)).rows, [{ presale_id: wallet("14") }]);
    assert.deepEqual((await db.read(`SELECT presale_id FROM ${SHOWN_PRESALES} sale WHERE ${liveSaleSql("sale", "20")}`)).rows, []);
  });
});
