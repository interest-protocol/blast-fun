import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import { seedChainRead, type ChainPresaleRow } from "../../../../../core/test/fixtures/modules/database/chain-read-rows.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";
import { autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { ITEM_BACKERS_MAX } from "@blast/core/modules/social/contracts/items.ts";
import { PRESALE_TOP_BACKERS } from "@blast/core/modules/social/contracts/presales.ts";
import { BACKERS_SQL } from "@blast/server/modules/social/items/mapper.ts";
import { TOP_BACKERS_SQL } from "@blast/server/modules/social/presales/detail.ts";
import { chainViewsOnly } from "@blast/core/modules/social/presales/sql.ts";
import { USDC_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";

/**
 * perf/sale-detail-naming: the sale read's two naming statements were
 * rewritten to touch only the rows they return — the top backers
 * (`TOP_BACKERS_SQL`: the kept wallets' first commits in one probe, each
 * owner once, identities by key) and the post-backers facepile
 * (`BACKERS_SQL`: only the commits' actors named, by address, instead of
 * every linked wallet). Both must answer byte for byte what the statements
 * they replaced answered. Those statements are kept here verbatim, as
 * 419753c built them, and both versions run as the replica role over one
 * dataset that exercises every naming branch and every tie-break:
 *
 * - accounts public, private and never sharing; sharing that starts at a
 *   commit's exact millisecond and half a millisecond after it; wallets
 *   linked before and after commits; two wallets for one account;
 * - all four sources of `social_wallet_owners` (Mission Control wallets, an
 *   embedded wallet by the account's DID and by a member's Privy identity,
 *   social wallets), an address two sources give one account, and two
 *   addresses claimed by two accounts (no sole owner, never named);
 * - unowned wallets, claims next to commits, a USDC sale and a SUI sale
 *   with commits without a USD value, a sale without commits, several
 *   sales in one call;
 * - equal commitments (wallet order), equal USD with equal and different
 *   latest commits (account order, then the latest first), a position with
 *   no commit in the log, and theses deleted and active.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const POOL = { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 4, statementTimeoutMs: 10_000 };

/** `readTopBackers`' statement as 419753c built it (`detail.ts`, the `sql.ts` helpers expanded). */
const TOP_BACKERS_BEFORE = `SELECT t.wallet, t.commitment::text AS commitment, t.last_commit_ms::text AS last_commit_ms, i.callsign AS person_callsign, i.display_name AS person_display_name,
  i.avatar_url AS person_avatar_url, (i.x_handle IS NOT NULL) AS person_verified,
       CASE WHEN t.account_id IS NULL THEN NULL ELSE (SELECT w.text FROM social_whys w
    WHERE w.presale_id = $1 AND w.state = 'active' AND w.presale_id IS NOT NULL AND w.author_account_id = t.account_id
    ORDER BY w.created_at DESC LIMIT 1) END AS why
     FROM (
       SELECT top.*, (SELECT position_owner.account_id
    FROM social_wallet_owners position_owner
    JOIN social_accounts position_account ON position_account.account_id = position_owner.account_id
    WHERE position_owner.address = top.wallet
      AND position_account.privacy = 'public'
      AND position_account.sharing_since IS NOT NULL
      AND extract(epoch FROM position_account.sharing_since) * 1000 <= (SELECT min(first_commit.timestamp_ms) FROM chain_read_v1.activity first_commit
    WHERE first_commit.actor = top.wallet AND first_commit.presale_id = $1 AND first_commit.kind = 'presale_commit')
      AND extract(epoch FROM position_owner.linked_at) * 1000 <= (SELECT min(first_commit.timestamp_ms) FROM chain_read_v1.activity first_commit
    WHERE first_commit.actor = top.wallet AND first_commit.presale_id = $1 AND first_commit.kind = 'presale_commit')) AS account_id
       FROM (
         SELECT pp.wallet, pp.commitment, pp.last_commit_ms
         FROM chain_read_v1.presale_positions pp
         WHERE pp.presale_id = $1
         ORDER BY pp.commitment DESC, pp.wallet
         LIMIT $2
       ) top
     ) t
     LEFT JOIN LATERAL (
    SELECT ii.callsign, ii.display_name, ii.avatar_url, ii.x_handle FROM social_account_identities ii WHERE ii.account_id = t.account_id
  ) i ON TRUE
     ORDER BY t.commitment DESC, t.wallet`;

/** `items/mapper.ts` `BACKERS_SQL` as 419753c built it (`namedWalletsSql()` expanded). */
const BACKERS_BEFORE = `SELECT backers.* FROM (
  WITH commits AS MATERIALIZED (
    SELECT e.presale_id, e.actor, e.usd_value, e.occurred_at_ms
    FROM social_feed_entries e
    WHERE e.source = 'activity' AND e.kind = 'presale_commit' AND e.presale_id = ANY($1::text[])
  ), named AS MATERIALIZED (
    SELECT named_owner.address, named_owner.account_id,
      greatest(extract(epoch FROM named_account.sharing_since), extract(epoch FROM named_owner.linked_at)) * 1000 AS named_from_ms
    FROM social_wallet_owners named_owner
    JOIN social_accounts named_account ON named_account.account_id = named_owner.account_id
    WHERE named_account.privacy = 'public' AND named_account.sharing_since IS NOT NULL
  )
  SELECT ranked.presale_id, ranked.rank, ranked.usd::text AS usd, i.callsign, i.display_name, i.avatar_url, i.verified
  FROM (
    SELECT backed.presale_id, backed.account_id, backed.usd,
      row_number() OVER (PARTITION BY backed.presale_id ORDER BY backed.usd DESC NULLS LAST, backed.last_ms DESC, backed.account_id) AS rank
    FROM (
      SELECT c.presale_id, n.account_id, sum(c.usd_value) AS usd, max(c.occurred_at_ms) AS last_ms
      FROM commits c
      JOIN named n ON n.address = c.actor AND n.named_from_ms <= c.occurred_at_ms
      GROUP BY c.presale_id, n.account_id
    ) backed
  ) ranked
  JOIN social_account_identities i ON i.account_id = ranked.account_id
  WHERE ranked.rank <= 12 AND i.callsign IS NOT NULL
  ) backers
  ORDER BY backers.presale_id, backers.rank`;

const T0 = 1_790_000_000_000;
const DAY = 86_400_000;

function hex(tag: string): string {
  return `0x${tag.padStart(64, "0")}`;
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const SUI = `${hex("2")}::sui::SUI`;
const P = { usdc: hex("5a1ea"), sui: hex("5a1eb"), empty: hex("5a1ec"), small: hex("5a1ed") } as const;
/** The sale of commit `k`: three in five to the USDC sale, one to the SUI sale, one to the small sale. */
const COMMIT_SALES = [P.usdc, P.usdc, P.sui, P.usdc, P.small];
const ACCOUNTS = 60;
const social = (n: number) => hex(`e0${String(n).padStart(4, "0")}`);
const second = (n: number) => hex(`e2${String(n).padStart(4, "0")}`);
const member = (m: number) => hex(`f2${m}`);
const unowned = (k: number) => hex(`d0${String(k).padStart(4, "0")}`);
const EMBEDDED_OWN = hex("e5010");
const EMBEDDED_MEMBER = hex("e5002");
/** A position with no commit in the log (its first commit is unknown, so it is never named). */
const CLAIM_ONLY = hex("c1a1");
/** Accounts 61-64: $500,000 each into the USDC sale, to tie the rankings (see `seed`). */
const TIED = [61, 62, 63, 64].map((n) => ({ n, account: uuid(n), wallet: hex(`7e${n}`) }));

/** Every wallet commits come from, in a fixed order. */
const ACTORS = [
  ...Array.from({ length: ACCOUNTS }, (_, i) => social(i + 1)),
  ...Array.from({ length: ACCOUNTS }, (_, i) => i + 1).filter((n) => n % 3 === 0).map(second),
  ...[1, 2, 3, 4].map(member),
  EMBEDDED_OWN,
  EMBEDDED_MEMBER,
  ...Array.from({ length: 25 }, (_, i) => unowned(i + 1)),
];

const at = (ms: string) => `('epoch'::timestamptz + (${ms}) * interval '1 millisecond')`;

function presale(presaleId: string, quote: string): ChainPresaleRow {
  const usdc = quote === USDC_COIN_TYPE;
  return {
    presale_id: presaleId, sale_token: `${presaleId}::coin::COIN`, quote_type: quote, sale_symbol: "EQ", sale_name: "Equal",
    sale_icon_url: "https://cdn.blast.fun/eq.png", sale_decimals: 9, quote_symbol: usdc ? "USDC" : "SUI", quote_decimals: usdc ? 6 : 9,
    lifecycle: "open", start_ms: T0 - DAY, end_ms: T0 + 10 * DAY, raise_target: "250000000000", min_commitment: "1000000",
    wallet_cap: null, total_commitments: "0", participants: 0, venue: null, pool_id: null, updated_checkpoint: 1,
  };
}

async function seed(admin: Pool): Promise<void> {
  await seedChainRead(admin, {
    presales: [presale(P.usdc, USDC_COIN_TYPE), presale(P.sui, SUI), presale(P.empty, USDC_COIN_TYPE), presale(P.small, USDC_COIN_TYPE)],
  });
  // New accounts: every ninth private, every eleventh never sharing; sharing starts between T0 and T0 + 750 s, on an exact
  // millisecond some commits share, or half a millisecond after it.
  await admin.query(
    `INSERT INTO social_accounts (account_id, privy_did, callsign, display_name, x_handle, x_avatar_url, privacy, sharing_since)
     SELECT ('00000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid, 'did:privy:eq-' || n, 'eq_' || n, 'Eq ' || n,
       CASE WHEN n % 2 = 0 THEN 'x_eq_' || n END, 'https://pbs.twimg.com/eq' || n || '.png',
       CASE WHEN n % 9 = 4 THEN 'private' ELSE 'public' END,
       CASE WHEN n % 9 = 4 OR n % 11 = 6 THEN NULL
         ELSE ${at(`$1::numeric + (n % 6) * 150000 + CASE WHEN n % 8 = 3 THEN 0.5 ELSE 0 END`)} END
     FROM generate_series(1, $2::int) n`,
    [T0, ACCOUNTS],
  );
  // Their wallets, linked between T0 and T0 + 600 s; every third account has a second one, linked at T0 + 400 s.
  await admin.query(
    `INSERT INTO social_account_wallets (address, account_id, verified_at)
     SELECT '0x' || lpad('e0' || lpad(n::text, 4, '0'), 64, '0'), ('00000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
       ${at("$1::numeric + (n % 4) * 200000")}
     FROM generate_series(1, $2::int) n
     UNION ALL
     SELECT '0x' || lpad('e2' || lpad(n::text, 4, '0'), 64, '0'), ('00000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
       ${at("$1::numeric + 400000")}
     FROM generate_series(1, $2::int) n WHERE n % 3 = 0`,
    [T0, ACCOUNTS],
  );
  // Four Mission Control members, each with a Mission Control wallet linked at T0 + m × 30 s.
  for (const m of [1, 2, 3, 4]) {
    await admin.query(
      `INSERT INTO mission_control_profiles (
         profile_id, privy_did, x_subject, x_handle, x_avatar_reference, sui_address, provider_wallet_reference, callsign,
         display_name, avatar_reference, disclosure_version, disclosure_accepted_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, 'fixture-v1', now())`,
      [uuid(0x100 + m), `did:privy:mc-${m}`, `x-mc-${m}`, `mc_x_${m}`, `https://pbs.twimg.com/mc${m}.png`, hex(`f1${m}`), `wallet-mc-${m}`,
        `mc_${m}`, `Member ${m}`],
    );
    await admin.query(
      `INSERT INTO social_accounts (account_id, profile_id, privacy, sharing_since, onboarded_at) VALUES ($1, $2, 'public', ${at("$3::numeric")}, now())`,
      [uuid(0x200 + m), uuid(0x100 + m), T0 + m * 60_000],
    );
    await admin.query(
      `INSERT INTO mission_control_account_wallets (wallet_id, profile_id, wallet_kind, sui_address, provider_wallet_reference, verified_at)
       VALUES ($1, $2, 'embedded', $3, $4, ${at("$5::numeric")})`,
      [uuid(0x300 + m), uuid(0x100 + m), member(m), `mc-wallet-${m}`, T0 + m * 30_000],
    );
  }
  // Member 1's wallet is also its social wallet (one owner, two sources); member 3's is also account 20's (no sole owner).
  await admin.query(
    `INSERT INTO social_account_wallets (address, account_id, verified_at) VALUES ($1, $2, ${at("$5::numeric")}), ($3, $4, ${at("$5::numeric")})`,
    [member(1), uuid(0x201), member(3), uuid(20), T0 + 500_000],
  );
  // Embedded wallets: account 10's by its DID, member 2's by its Privy identity, and account 12's at account 5's address.
  await admin.query(
    `INSERT INTO mission_control_account_identities (profile_id, provider, provider_subject, verified_at) VALUES ($1, 'privy', 'did:privy:mc-2-embedded', now())`,
    [uuid(0x102)],
  );
  await admin.query(
    `INSERT INTO presale_embedded_wallets (privy_did, address, resolved_at)
     VALUES ('did:privy:eq-10', $1, ${at("$4::numeric + 100000")}), ('did:privy:mc-2-embedded', $2, ${at("$4::numeric + 100000")}),
       ('did:privy:eq-12', $3, ${at("$4::numeric")})`,
    [EMBEDDED_OWN, EMBEDDED_MEMBER, social(5), T0],
  );
  // 2,400 commits over 1,200 seconds (two per millisecond stamp) from ACTORS, in six amounts; the SUI sale's every fourth
  // without a USD value. Every seventeenth commit has a claim beside it, which no statement counts.
  await admin.query(
    `INSERT INTO blast_infra_fixture.activity
     SELECT s.checkpoint, 0, 0, 0, $1::bigint + (s.k % 1200) * 1000, 'Dg' || s.checkpoint, s.kind, 'presale', s.actor, s.actor, s.presale,
       NULL, CASE WHEN s.presale = $4 THEN $6 ELSE $5 END, s.amount, NULL, NULL,
       CASE WHEN s.presale = $4 AND s.k % 4 = 0 THEN NULL WHEN s.presale = $4 THEN s.amount / 1000000000 * 1.25 ELSE s.amount / 1000000 END,
       NULL, NULL, NULL, NULL
     FROM (
       SELECT k, 500000 + k AS checkpoint, 'presale_commit' AS kind,
         ($2::text[])[1 + (k * 37 + k / 113) % cardinality($2::text[])] AS actor, ($3::text[])[1 + k % 5] AS presale,
         (ARRAY[100, 250, 500, 1000, 5000, 250])[1 + (k * 7) % 6]::numeric * CASE WHEN ($3::text[])[1 + k % 5] = $4 THEN 1000000000 ELSE 1000000 END AS amount
       FROM generate_series(0, 2399) k
       UNION ALL
       SELECT k, 600000 + k, 'presale_claim', ($2::text[])[1 + (k * 37 + k / 113) % cardinality($2::text[])], ($3::text[])[1 + k % 5], 1000000
       FROM generate_series(0, 2399) k WHERE k % 17 = 0
     ) s`,
    [T0, ACTORS, COMMIT_SALES, P.sui, USDC_COIN_TYPE, SUI],
  );
  // Accounts 61-64 put $500,000 each into the USDC sale: 61 and 62 at the same millisecond, 64 in two commits ending there,
  // 63 earlier. The facepile ties them on USD (then the latest commit, then the account); the positions tie on commitment.
  for (const { n, account, wallet } of TIED) {
    await admin.query(
      `INSERT INTO social_accounts (account_id, privy_did, callsign, display_name, privacy, sharing_since) VALUES ($1, $2, $3, $4, 'public', ${at("$5::numeric")})`,
      [account, `did:privy:eq-${n}`, `eq_${n}`, `Eq ${n}`, T0],
    );
    await admin.query(`INSERT INTO social_account_wallets (address, account_id, verified_at) VALUES ($1, $2, ${at("$3::numeric")})`, [wallet, account, T0]);
  }
  const big = [[61, 1_500, 500_000], [62, 1_500, 500_000], [63, 1_400, 500_000], [64, 1_450, 250_000], [64, 1_500, 250_000]] as const;
  for (const [index, [n, seconds, usd]] of big.entries()) {
    await admin.query(
      `INSERT INTO blast_infra_fixture.activity
       VALUES ($1, 0, 0, 0, $2, $3, 'presale_commit', 'presale', $4, $4, $5, NULL, $6, $7, NULL, NULL, $8, NULL, NULL, NULL, NULL)`,
      [700000 + index, T0 + seconds * 1_000, `Big${index}`, TIED.find((tied) => tied.n === n)!.wallet, P.usdc, USDC_COIN_TYPE, usd * 1_000_000, usd],
    );
  }
  // Positions as blast-infra keeps them, and one held by account 1's wallet with no commit in the log.
  await admin.query(
    `INSERT INTO blast_infra_fixture.presale_positions
     SELECT presale_id, actor, sum(quote_amount), max(timestamp_ms), NULL, NULL, NULL, NULL
     FROM blast_infra_fixture.activity WHERE kind = 'presale_commit' GROUP BY presale_id, actor`,
  );
  await admin.query("INSERT INTO social_account_wallets (address, account_id, verified_at) VALUES ($1, $2, now() - interval '400 days')", [CLAIM_ONLY, uuid(1)]);
  await admin.query("INSERT INTO blast_infra_fixture.presale_positions VALUES ($1, $2, 900000000000, NULL, NULL, NULL, NULL, NULL)", [P.usdc, CLAIM_ONLY]);
  // Theses by the owner of every seventh commit's social wallet (every other one of those deleted), and on the big commits.
  await admin.query(
    `INSERT INTO social_whys (why_id, entry_id, author_account_id, text, state, created_at, deleted_at)
     SELECT ('00000000-0000-4000-9000-' || lpad(to_hex(a.checkpoint), 12, '0'))::uuid, 'a:' || a.checkpoint || ':0:0:0', owner.account_id,
       'Why ' || a.checkpoint, CASE WHEN a.checkpoint % 14 = 0 THEN 'deleted' ELSE 'active' END,
       ${at("$1::numeric + (a.checkpoint - 500000) * 1000")}, CASE WHEN a.checkpoint % 14 = 0 THEN now() END
     FROM blast_infra_fixture.activity a
     JOIN social_account_wallets owner ON owner.address = a.actor
     WHERE a.kind = 'presale_commit' AND (a.checkpoint % 7 = 0 OR a.checkpoint >= 700000)`,
    [T0],
  );
  await admin.query("ANALYZE");
}

type Fixture = Readonly<{ replica: ReadableDatabase }>;

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const database = await freshTestDatabase();
  const { url } = database;
  const admin = createPool(url, { max: 2 });
  await seed(admin);
  const pool = createRuntimePool(urlAs(url, "blast_replica"), POOL, "social-naming-reads");
  try {
    await run({ replica: chainViewsOnly(autocommitReader(pool, "social")) });
  } finally {
    await pool.end();
    await admin.end();
    await database.drop();
  }
}

type Row = Record<string, unknown>;

/** Both statements' rows for the same values; the new ones must be the old ones, byte for byte. */
async function same(db: ReadableDatabase, label: string, before: string, after: string, values: unknown[]): Promise<Row[]> {
  const [old, now] = await Promise.all([db.read<Row>(before, values), db.read<Row>(after, values)]);
  assert.equal(JSON.stringify(now.rows), JSON.stringify(old.rows), label);
  assert.deepEqual(now.rows, old.rows, label);
  return old.rows;
}

test("the rewritten top backers and facepile answer exactly what the statements they replace answered", { skip }, async () => {
  await withFixture(async ({ replica }) => {
    assert.equal(ITEM_BACKERS_MAX, 12, "BACKERS_BEFORE keeps 12 per sale");
    assert.equal(PRESALE_TOP_BACKERS, 25);
    const all = Object.values(P);

    // The top backers, for each sale and around the limit.
    const tops = new Map<string, Row[]>();
    for (const presaleId of all) {
      for (const limit of [PRESALE_TOP_BACKERS, 4, 1, 500]) {
        const rows = await same(replica, `top backers ${presaleId} limit ${limit}`, TOP_BACKERS_BEFORE, TOP_BACKERS_SQL, [presaleId, limit]);
        if (limit === 500) tops.set(presaleId, rows);
      }
    }

    // The facepile, per sale and for several sales in one call (as a feed page asks).
    const piles = new Map<string, Row[]>();
    for (const presaleIds of [[P.usdc], [P.sui], [P.empty], [P.small], all, [P.small, P.sui]]) {
      const rows = await same(replica, `facepile ${presaleIds.join(",")}`, BACKERS_BEFORE, BACKERS_SQL, [presaleIds]);
      piles.set(presaleIds.join(","), rows);
    }

    // The dataset reaches what the comparison claims to cover.
    const usdcTop = tops.get(P.usdc)!;
    assert.equal(usdcTop[0]!.wallet, CLAIM_ONLY, "the largest position has no commit in the log");
    assert.equal(usdcTop[0]!.person_callsign, null, "so it is not named, though its wallet has an owner");
    assert.deepEqual(usdcTop.slice(1, 5).map((row) => [row.commitment, row.wallet]), TIED.map((tied) => tied.wallet).sort()
      .map((wallet) => ["500000000000", wallet]), "equal commitments in wallet order");
    for (const presaleId of [P.usdc, P.sui, P.small]) {
      const rows = tops.get(presaleId)!;
      assert.ok(rows.some((row) => row.person_callsign !== null), `${presaleId}: a named position`);
      assert.ok(rows.some((row) => row.person_callsign === null), `${presaleId}: an unnamed position`);
    }
    assert.ok(usdcTop.some((row) => typeof row.why === "string"), "a named position with its latest active thesis");
    assert.ok(usdcTop.some((row) => row.person_callsign !== null && row.why === null), "a named position without one");
    assert.ok([...tops.values()].flat().some((row) => typeof row.person_callsign === "string" && row.person_callsign.startsWith("mc_")),
      "a Mission Control member named");
    assert.deepEqual(tops.get(P.empty), []);

    const usdcPile = piles.get(P.usdc)!;
    assert.equal(usdcPile.length, ITEM_BACKERS_MAX);
    assert.deepEqual(usdcPile.slice(0, 4).map((row) => [row.callsign, row.usd]),
      [["eq_61", "500000"], ["eq_62", "500000"], ["eq_64", "500000"], ["eq_63", "500000"]],
      "equal USD: the latest commit first, then the account");
    assert.equal(piles.get(P.sui)!.length, ITEM_BACKERS_MAX);
    assert.deepEqual(piles.get(P.empty), []);
    assert.deepEqual(new Set(piles.get(all.join(","))!.map((row) => row.presale_id)), new Set([P.usdc, P.sui, P.small]));
  });
});
