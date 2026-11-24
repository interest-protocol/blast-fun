// Social feed Create scale evidence (UI-20): seed a launch-scale disposable
// database (10k accounts, 25k presale drafts of realistic size, one account
// at the draft limit, and a 65,536-wallet presale allowlist) and time the
// Create routes' statements with their plans (EXPLAIN ANALYZE, BUFFERS),
// running as the web role.
//
//   SOCIAL_SCALE_DATABASE_URL=postgresql://postgres:<pw>@127.0.0.1:<port>/<db> \
//     node --no-warnings --import ./scripts/test-tsx-hooks.mjs --experimental-strip-types loadtest/social-create-scale.ts seed|bench
//
// The database must be a disposable loopback Postgres (seed resets it). bench
// prints p50/p95 per statement and writes the plans to
// loadtest/results/social-create-scale-plans.txt.
import fs from "node:fs";

import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { CHAIN_FIXTURE, resetSharedDatabase, urlAs } from "../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { blankDraft } from "@blast/core/modules/social/create/model.ts";

const URL_ = process.env.SOCIAL_SCALE_DATABASE_URL ?? "";
if (!/^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost):\d+\/\w+$/.test(URL_)) {
  throw new Error("SOCIAL_SCALE_DATABASE_URL must name a disposable loopback database (seed resets it).");
}
const ACCOUNTS = 10_000, DRAFTS = 25_000, HEAVY_DRAFTS = 25, ALLOWLIST_ROWS = 65_536, RUNS = 30;
const uuid = (n: string) => `('00000000-0000-4000-8000-' || lpad(to_hex(${n}), 12, '0'))::uuid`;
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const HEAVY = id(1);

/** A realistic draft body: the design's sample with addresses typed and a few more recipients (about 3 KB). */
function body(n: number): string {
  const draft = blankDraft();
  const address = (tag: number) => `0x${tag.toString(16).padStart(64, "0")}`;
  return JSON.stringify({
    ...draft,
    name: `Token ${n}`,
    symbol: `T${n % 100_000}`,
    tagline: "Onchain FX for stablecoins on Sui",
    token_recipients: [...draft.token_recipients, ...draft.token_recipients].map((row, i) => ({ ...row, address: address(n * 10 + i) })),
    raise_recipients: draft.raise_recipients.map((row, i) => ({ ...row, address: address(n * 10 + i) })),
  });
}

async function seed() {
  const admin = createPool(URL_, { max: 2 });
  await resetSharedDatabase(admin);
  await admin.query(CHAIN_FIXTURE);
  await migrateDatabase(admin);
  await admin.query(
    `INSERT INTO social_accounts (account_id, privy_did, callsign, onboarded_at, privacy, sharing_since)
     SELECT ${uuid("n")}, 'did:privy:scale-' || n, 'acct_' || n, now(), 'public', now() FROM generate_series(1, ${ACCOUNTS}) n`,
  );
  // 25k drafts over the first 8k accounts; account 1 holds the limit (25).
  const template = body(7);
  await admin.query(
    `INSERT INTO social_presale_drafts (draft_id, account_id, version, body, logo_url, created_at, updated_at)
     SELECT ${uuid("100000 + n")},
       CASE WHEN n <= ${HEAVY_DRAFTS} THEN ${uuid("1")} ELSE ${uuid(`2 + (n % ${ACCOUNTS - 2000})`)} END,
       1 + n % 40, $1::jsonb || jsonb_build_object('name', 'Token ' || n),
       CASE WHEN n % 3 = 0 THEN 'https://blob.example/create-logos/' || n || '.webp' END,
       now() - (n || ' minutes')::interval, now() - (n || ' seconds')::interval
     FROM generate_series(1, ${DRAFTS}) n`,
    [template],
  );
  await admin.query(
    `INSERT INTO presale_allowlists (id, owner_kind, owner_id, quote, root, leaf_count, entry_count, total_cap, warnings)
     VALUES ($1, 'account', 'did:privy:scale-1', '0x' || repeat('d', 64) || '::usdc::USDC', $2, ${ALLOWLIST_ROWS}, ${ALLOWLIST_ROWS}, 1000000000000, '[]')`,
    [id(0xa11), "ab".repeat(32)],
  );
  await admin.query(
    `INSERT INTO presale_allowlist_entries (allowlist_id, index, wallet, wallet_cap, proof)
     SELECT $1, n, '0x' || lpad(to_hex(n), 64, '0'), (100 + n % 4900)::bigint * 1000000, ARRAY[sha256(convert_to(n::text, 'UTF8'))]
     FROM generate_series(0, ${ALLOWLIST_ROWS - 1}) n`,
    [id(0xa11)],
  );
  await admin.query("ANALYZE");
  const sizes = await admin.query("SELECT count(*)::int AS drafts, pg_size_pretty(pg_total_relation_size('social_presale_drafts')) AS size, avg(octet_length(body::text))::int AS avg_body FROM social_presale_drafts");
  console.log(JSON.stringify(sizes.rows[0]));
  await admin.end();
}

type Statement = Readonly<{ name: string; sql: string; values: unknown[] }>;

async function bench() {
  const web = createPool(urlAs(URL_, "blast_web"), { max: 2 });
  const draft = body(42);
  const page = await web.query<{ updated_at: string; draft_id: string }>(
    `SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at, draft_id::text FROM social_presale_drafts
     WHERE account_id = $1 ORDER BY updated_at DESC, draft_id DESC OFFSET 19 LIMIT 1`,
    [HEAVY],
  );
  const cursor = page.rows[0]!;
  const target = (await web.query<{ draft_id: string; version: number }>("SELECT draft_id::text, version FROM social_presale_drafts WHERE account_id = $1 LIMIT 1", [id(500)])).rows[0]!;
  const statements: Statement[] = [
    { name: "read one draft", sql: "SELECT draft_id::text, version, body, logo_url, allowlist FROM social_presale_drafts WHERE draft_id = $1 AND account_id = $2", values: [target.draft_id, id(500)] },
    {
      name: "list first page (heavy account, 25 drafts)",
      sql: `SELECT draft_id::text AS id, version, COALESCE(body->>'name', '') AS name, COALESCE(body->>'symbol', '') AS symbol, logo_url, updated_at
            FROM social_presale_drafts WHERE account_id = $1 AND ($2::timestamptz IS NULL OR (updated_at, draft_id) < ($2::timestamptz, $3::uuid))
            ORDER BY updated_at DESC, draft_id DESC LIMIT 21`,
      values: [HEAVY, null, null],
    },
    {
      name: "list after a cursor (heavy account)",
      sql: `SELECT draft_id::text AS id, version, COALESCE(body->>'name', '') AS name, COALESCE(body->>'symbol', '') AS symbol, logo_url, updated_at
            FROM social_presale_drafts WHERE account_id = $1 AND ($2::timestamptz IS NULL OR (updated_at, draft_id) < ($2::timestamptz, $3::uuid))
            ORDER BY updated_at DESC, draft_id DESC LIMIT 21`,
      values: [HEAVY, cursor.updated_at, cursor.draft_id],
    },
    { name: "count for the draft limit (heavy account)", sql: "SELECT count(*)::int FROM social_presale_drafts WHERE account_id = $1", values: [HEAVY] },
    {
      name: "save over the version (rolled back)",
      sql: `UPDATE social_presale_drafts SET body = $4::jsonb, allowlist = NULL, version = version + 1, updated_at = clock_timestamp()
            WHERE draft_id = $1 AND account_id = $2 AND version = $3 RETURNING version`,
      values: [target.draft_id, id(500), target.version, draft],
    },
    {
      name: "create (rolled back)",
      sql: "INSERT INTO social_presale_drafts (draft_id, account_id, version, body) VALUES ($1, $2, 1, $3::jsonb) ON CONFLICT (draft_id) DO NOTHING RETURNING version",
      values: [id(0xfeed), id(9_000), draft],
    },
    {
      name: "allowlist cap range (65,536 wallets)",
      sql: `SELECT a.root, a.leaf_count, min(e.wallet_cap)::text AS min_cap, max(e.wallet_cap)::text AS max_cap
            FROM presale_allowlists a LEFT JOIN presale_allowlist_entries e ON e.allowlist_id = a.id
            WHERE a.id = $1 AND a.owner_kind = 'account' AND a.owner_id = $2 GROUP BY a.id`,
      values: [id(0xa11), "did:privy:scale-1"],
    },
  ];
  const plans: string[] = [];
  for (const statement of statements) {
    const times: number[] = [];
    let plan = "";
    for (let run = 0; run < RUNS; run += 1) {
      const client = await web.connect();
      try {
        // Every statement runs in a transaction that is rolled back, so the writes leave nothing behind.
        await client.query("BEGIN");
        const result = await client.query<{ "QUERY PLAN": unknown }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.sql}`, statement.values);
        const json = (result.rows[0]!["QUERY PLAN"] as { "Planning Time": number; "Execution Time": number }[])[0]!;
        times.push(json["Planning Time"] + json["Execution Time"]);
        if (run === RUNS - 1) {
          const text = await client.query<Record<string, string>>(`EXPLAIN (ANALYZE, BUFFERS) ${statement.sql}`, statement.values);
          plan = text.rows.map((row) => row["QUERY PLAN"]).join("\n");
        }
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
    }
    times.sort((a, b) => a - b);
    const pct = (p: number) => times[Math.min(times.length - 1, Math.ceil((p / 100) * times.length) - 1)]!.toFixed(2);
    console.log(`${statement.name}: p50 ${pct(50)} ms, p95 ${pct(95)} ms`);
    plans.push(`== ${statement.name} ==\n${plan}\n`);
  }
  fs.mkdirSync("loadtest/results", { recursive: true });
  fs.writeFileSync("loadtest/results/social-create-scale-plans.txt", plans.join("\n"));
  await web.end();
}

if (process.argv[2] === "seed") await seed();
else if (process.argv[2] === "bench") await bench();
else throw new Error("Usage: social-create-scale.ts seed|bench");
