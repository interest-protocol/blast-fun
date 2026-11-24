// Driven by blast-infra's ignored wallet_metadata_portfolio_scale test; never uses DATABASE_URL.
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { migrateDatabase } from "../../../packages/core/src/modules/database/migrations.ts";
import { autocommitReader } from "../../../packages/core/src/modules/database/transaction.ts";
import { assemblePortfolio } from "@blast/server/modules/social/portfolio/route.ts";
import { readAccountAddresses } from "@blast/server/modules/social/accounts/read-wallet-addresses.ts";
import { readCostBasisLedger } from "@blast/server/modules/social/portfolio/cost-basis.ts";
import { readWalletHoldings } from "@blast/server/modules/social/portfolio/wallet-holdings.ts";
import { parseProcStat } from "./lib/proc-stat.mjs";

// react-doctor-disable-next-line react-doctor/no-unguarded-throwing-parse-call -- This disposable-database CLI intentionally rejects malformed configuration before creating any pool.
const url = new URL(process.env.WALLET_SCALE_DATABASE_URL ?? "invalid:");
assert.equal(url.hostname, "127.0.0.1");
assert.match(url.pathname, /^\/blast_test_\d+_\d+_\d+$/);
const pool = new pg.Pool({
  connectionString: url.href,
  max: 10,
  connectionTimeoutMillis: 2000,
  options:
    "-c role=blast_web -c statement_timeout=8000 -c lock_timeout=3000 -c default_transaction_read_only=on",
});
const admin = new pg.Pool({ connectionString: url.href, max: 2 });
const db = autocommitReader(pool, "social", { prepare: true });
const walletDb = autocommitReader(pool, "social");
const ownerSql = "'0x' || lpad(to_hex(n),64,'0')";
const loadCoinSuffix = `::load::Coin<0x${"2".padStart(64, "0")}::sui::SUI>`;
const coinSql = (n: string) =>
  `('0x' || lpad(to_hex(${n}),64,'0') || '${loadCoinSuffix}')`;
const account = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const accountSql = (n: string) =>
  `('00000000-0000-4000-8000-' || lpad(to_hex(${n}),12,'0'))::uuid`;
const owner = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
let http: Awaited<ReturnType<typeof import("./lib/wallet-http.mjs").startWalletHttp>> | undefined;
const httpMode = !!process.env.WALLET_SCALE_HTTP_DIR;
const MAX_INFLIGHT = 250; // 500 reads/s × the 500 ms latency budget; application pools are bounded separately.
const report: Record<string, unknown> = { max_inflight: MAX_INFLIGHT };
function save() {
  if (process.env.WALLET_SCALE_REPORT)
    fs.writeFileSync(
      process.env.WALLET_SCALE_REPORT,
      JSON.stringify(report, null, 2),
    );
}
async function seed() {
  await migrateDatabase(admin);
  if (httpMode) await admin.query("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
  for (let start = 1; start <= 50_000; start += 1000) {
    await admin.query(
      `INSERT INTO social_accounts(account_id,privy_did,callsign,privacy,onboarded_at)
      SELECT ${accountSql("n")}, 'did:privy:load-'||n, 'scale_'||n, 'private', now()
      FROM generate_series($1::int,$2::int) n`,
      [start, start + 999],
    );
  }
  await admin.query(`INSERT INTO social_account_wallets(address,account_id,verified_at)
    SELECT ${ownerSql}, ${accountSql("(n+1)/2")}, now() FROM generate_series(1,100000) n`);
  await admin.query(`SET search_path=blast_infra,public;
    INSERT INTO wallet_tracking(owner,applied_checkpoint,refreshed_at,next_attempt_at)
      SELECT ${ownerSql}, CASE WHEN n<=98000 THEN 10 END, CASE WHEN n<=98000 THEN now() END,
      CASE WHEN n<=98000 THEN now()+interval '1 day' ELSE now() END FROM generate_series(1,100000) n;
    INSERT INTO wallet_coin_types SELECT ${coinSql("n")} FROM generate_series(1,10000) n;
    INSERT INTO hydrated_coin_metadata(coin_type,name,symbol,decimals,next_attempt_at)
      SELECT ${coinSql("n")}, 'Load Coin '||n, 'C'||n,9,now()+interval '1 day' FROM generate_series(1,9000) n;
    INSERT INTO wallet_balances SELECT ${ownerSql}, ${coinSql("(n*5+i)%10000+1")},1000000000
      FROM generate_series(1,98000) n CROSS JOIN generate_series(0,4) i;
    INSERT INTO presale_wallets(presale_id,address,commitment,commit_count,last_committed_checkpoint,
      last_committed_timestamp_ms,applied_checkpoint,applied_tx_slot,applied_event_slot)
      SELECT s.presale_id, ${ownerSql},1000000000,1,10,1000,10,0,0
      FROM generate_series(1,100000) n CROSS JOIN generate_series(0,1) i
      JOIN (SELECT presale_id,row_number() OVER (ORDER BY presale_id) AS rn FROM presales) s ON s.rn=(n+i)%2000+1;
    INSERT INTO activity(checkpoint,tx_slot,event_slot,part,timestamp_ms,digest,kind,product,actor,tx_sender,
      presale_id,coin_type,quote_type,quote_amount,usd_value,usd_price_as_of_ms)
      SELECT 1,row_number() OVER ()::int,0,0,1000,'load-commit-'||w.address||p.presale_id,
      'presale_commit','presale',w.address,w.address,p.presale_id,p.meme_type,p.quote_type,1000000000,1,1000
      FROM presale_wallets w JOIN presales p USING(presale_id);
    INSERT INTO balance_history_coverage VALUES(true,10,10,(extract(epoch FROM now())*1000)::bigint);
    INSERT INTO checkpoint_journal VALUES(10,'mainnet','scale-digest-10',NULL,0,1000,1,1,''::bytea,decode(repeat('00',32),'hex'));
    RESET search_path;`);
  await admin.query(`INSERT INTO social_portfolio_snapshots(account_id,day,skipped,taken_at_ms,checkpoint)
    SELECT account_id,current_date-d,'price_missing',extract(epoch FROM (current_date-d))*1000,10
    FROM social_accounts CROSS JOIN generate_series(1,7) d`);
  if (httpMode) await admin.query(`
    INSERT INTO mission_control_profiles(profile_id,privy_did,x_subject,sui_address,provider_wallet_reference,callsign,disclosure_version,disclosure_accepted_at)
      SELECT ${accountSql("n")},'did:privy:load-'||n,'load-x-'||n,'0x'||lpad(to_hex(2*n-1),64,'0'),'load-wallet-'||n,'member_'||n,'fixture-v1',now()
      FROM generate_series(5,50000,5) n;
    INSERT INTO mission_control_account_identities(profile_id,provider,provider_subject,verified_at)
      SELECT profile_id,'privy',privy_did,now() FROM mission_control_profiles;
    INSERT INTO mission_control_account_wallets(wallet_id,profile_id,wallet_kind,sui_address,provider_wallet_reference,is_primary,verified_at)
      SELECT gen_random_uuid(),profile_id,'embedded',sui_address,provider_wallet_reference,true,now() FROM mission_control_profiles;
    UPDATE social_accounts SET profile_id=account_id,privy_did=NULL,callsign=NULL WHERE account_id IN (SELECT profile_id FROM mission_control_profiles);
  `);
  await admin.query("VACUUM ANALYZE");
  console.log(
    "Seeded: 50,000 accounts, 100,000 linked wallets, 490,000 balances, 10,000 coin types, 2,000 queued wallets, 1,000 cold metadata types, 2,000 presales, 200,000 activity rows",
  );
}
async function plans() {
  const plans: unknown[] = [];
  await readWalletHoldings(
    {
      read: async (text, values) => {
        plans.push(
          (
            await pool.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${text}`, [
              ...(values ?? []),
            ])
          ).rows,
        );
        return pool.query(text, [...(values ?? [])]);
      },
    },
    [owner(101), owner(102)],
  );
  report.plans = plans;
  const accountPlans: unknown[] = [];
  const accountSource = fs.readFileSync("packages/core/src/modules/social/accounts/repository.ts", "utf8");
  for (const [name, value] of [["ACCOUNT_BY_DID", "did:privy:load-51"], ["ACCOUNT_BY_DID", "did:privy:load-50"], ["WALLETS_BY_ACCOUNT", account(51)], ["WALLETS_BY_ACCOUNT", account(50)]]) {
    const declaration = accountSource.split(`const ${name} = \``)[1];
    assert(declaration, `Missing account query ${name}`);
    const sql = declaration.split("`;", 1)[0];
    assert(sql, `Empty account query ${name}`);
    accountPlans.push((await pool.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`, [value])).rows);
  }
  report.account_plans = accountPlans;
  if (process.env.BLAST_SCALE_INFRA) {
    report.worker_plans = {};
    for (const [file, name] of [
      ["wallet_balances.rs", "CLAIM"],
      ["coin_metadata.rs", "CANDIDATES"],
    ]) {
      const source = fs.readFileSync(
        `${process.env.BLAST_SCALE_INFRA}/src/${file}`,
        "utf8",
      );
      const declaration = source.match(new RegExp(`const ${name}: &str = "([\\s\\S]*?)";`));
      const rawSql = declaration?.[1];
      assert(rawSql, `Missing worker query ${name}`);
      const sql = rawSql.replace(/\\\n\s*/g, "");
      const client = await admin.connect();
      try {
        await client.query("BEGIN; SET LOCAL search_path=blast_infra");
        (report.worker_plans as Record<string, unknown>)[name!] = (
          await client.query(
            `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`,
            name === "CLAIM" ? [8] : [],
          )
        ).rows;
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }
  }
  const ledger = await readCostBasisLedger(db, [owner(101), owner(102)]);
  assert.equal(ledger.rows.length, 4);
  assert.equal(ledger.truncated, false);
  const portfolioPlans: unknown[] = [];
  await assemblePortfolio({
    db: {
      read: async (text, values) => {
        portfolioPlans.push({
          sql: text,
          plan: (
            await pool.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${text}`, [
              ...(values ?? []),
            ])
          ).rows,
        });
        return pool.query(text, [...(values ?? [])]);
      },
    },
    accountId: account(51),
    addresses: [owner(101), owner(102)],
    now: Date.now,
  });
  report.portfolio_plans = portfolioPlans;
  const times: number[] = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Measure isolated serial portfolio latency; overlapping reads would change the benchmark.
    const result = await assemblePortfolio({
      db,
      accountId: account(51),
      addresses: [owner(101), owner(102)],
      now: Date.now,
    });
    assert.deepEqual(result.unavailable, []);
    assert.equal(result.coins?.length, 10);
    times.push(performance.now() - start);
  }
  report.serial = summarize(times);
  report.prepared_plans = (await pool.query("SELECT name, generic_plans::int, custom_plans::int, left(statement,100) AS sql FROM pg_prepared_statements")).rows;
  save();
  type Plan = {
    "Relation Name"?: string;
    "Actual Rows"?: number;
    Plans?: Plan[];
  };
  type ExplainRows = { "QUERY PLAN": { Plan: Plan }[] }[];
  function indexedMetadata(plan: Plan) {
    assert(
      !(
        ["presales", "hydrated_coin_metadata", "social_accounts", "social_account_wallets"].includes(
          plan["Relation Name"] ?? "",
        ) && (plan["Actual Rows"] ?? 0) > 500
      ),
      "portfolio scans unrelated coin metadata or presales",
    );
    for (const child of plan.Plans ?? []) indexedMetadata(child);
  }
  for (const rows of [...plans, ...accountPlans] as ExplainRows[])
    indexedMetadata(rows[0]!["QUERY PLAN"][0]!.Plan);
  for (const q of portfolioPlans as { plan: ExplainRows }[])
    indexedMetadata(q.plan[0]!["QUERY PLAN"][0]!.Plan);
  console.log(JSON.stringify(report.serial));
}
function summarize(samples: number[]) {
  samples.sort((a, b) => a - b);
  const at = (q: number) =>
    +(
      samples[Math.min(samples.length - 1, Math.floor(samples.length * q))] ?? 0
    ).toFixed(2);
  return {
    count: samples.length,
    p50_ms: at(0.5),
    p95_ms: at(0.95),
    p99_ms: at(0.99),
    max_ms: at(1),
  };
}
function assertAccountBalances(coins: NonNullable<Awaited<ReturnType<typeof assemblePortfolio>>["coins"]>, n: number) {
  const expected = new Map<string, string>();
  for (const wallet of [n * 2 - 1, n * 2]) for (let j=0;j<5;j++)
    expected.set(`${owner((wallet*5+j)%10000+1)}::load::Coin<${owner(2)}::sui::SUI>`, String(1000000000+(j===0 ? wallet : 0)));
  for (const coin of coins) assert.equal(coin.balance, expected.get(coin.coin_type));
}
let arrivals = 0;
async function phase(rate: number, seconds: number) {
  const samples: number[] = [],
    errors: string[] = [],
    pending = new Set<Promise<void>>();
  const start = performance.now();
  let dropped = 0,
    peak = 0,
    errorCount = 0;
  for (let i = 0; i < rate * seconds; i++) {
    const due = start + (i * 1000) / rate;
    const delay = due - performance.now();
    if (delay > 0) await sleep(delay);
    // Open-loop arrivals; bound the load generator so overload cannot consume unlimited memory.
    if (pending.size >= MAX_INFLIGHT) {
      dropped++;
      continue;
    }
    const sequence = arrivals++;
    const n = ((sequence * 7919) % 49000) + 1;
    const task = (async () => {
      try {
        const addresses = http ? [] : await readAccountAddresses(walletDb, account(n));
        const value = http ? await http.read(n, Math.floor(sequence / 2) % 8) : await assemblePortfolio({
          db,
          accountId: account(n),
          addresses,
          now: Date.now,
        });
        assert.deepEqual(value.unavailable, []);
        assert.equal(value.wallet_sync?.status, "ready");
        assert.equal(value.coins?.length, 10);
        assert(value.positions);
        assert.equal(value.positions.length, 3);
        assert.equal(
          value.positions.reduce((sum, p) => sum + BigInt(p.commitment), 0n),
          4000000000n,
        );
        assert(value.coins);
        if (http) assertAccountBalances(value.coins, n);
        else assert(value.coins.every((c) => c.balance === "1000000000"));
        assert(
          value.coins.every((c) => c.decimals === 9 || c.decimals === null),
        );
        samples.push(performance.now() - due); // Includes scheduler delay: no coordinated omission.
      } catch (e) {
        errorCount++;
        if (errors.length < 10) errors.push(String(e));
      }
    })();
    pending.add(task);
    peak = Math.max(peak, pending.size);
    void task.finally(() => pending.delete(task));
  }
  await Promise.all(pending);
  const result = {
    rate,
    seconds,
    elapsed_seconds: +((performance.now() - start) / 1000).toFixed(2),
    ...summarize(samples),
    dropped,
    error_count: errorCount,
    errors,
    peak_inflight: peak,
    pool_connections: pool.totalCount,
  };
  console.log(JSON.stringify(result));
  return result;
}
function assertPhase(p: Awaited<ReturnType<typeof phase>>) {
  assert.equal(p.error_count, 0);
  assert.equal(p.dropped, 0);
  assert.equal(p.count, p.rate * p.seconds);
  assert(p.elapsed_seconds < p.seconds + 2, "generator failed to sustain offered rate");
  assert(p.p95_ms < 500, `p95 exceeded 500ms at ${p.rate} reads/s`);
}
async function bench() {
  const ticks = Number(
    execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }),
  );
  const backend = (await admin.query("SELECT pg_backend_pid() pid")).rows[0]
    .pid;
  const pgParent = parseProcStat(fs.readFileSync(`/proc/${backend}/stat`, "utf8")).parent;
  let previousCpu = 0,
    previousAt = performance.now();
  function resources() {
    const rows = fs
      .readdirSync("/proc")
      .filter((name) => /^\d+$/.test(name))
      .flatMap((pid) => {
        try {
          const stat = parseProcStat(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
          return [
            {
              pid: Number(pid),
              parent: stat.parent,
              cpu: stat.cpu,
            },
          ];
        } catch {
          return [];
        }
      });
    const descendants = new Set([process.pid]);
    for (let depth=0;depth<5;depth++) for (const row of rows) if(descendants.has(row.parent)) descendants.add(row.pid);
    const scoped = rows.filter(
      (r) =>
        descendants.has(r.pid) ||
        r.pid === process.ppid ||
        r.pid === pgParent ||
        r.parent === pgParent,
    );
    const cpu = scoped.reduce((sum, r) => sum + r.cpu, 0);
    let pss = 0;
    for (const r of scoped) {
      try {
        pss += Number(
          fs
            .readFileSync(`/proc/${r.pid}/smaps_rollup`, "utf8")
            .match(/^Pss:\s+(\d+)/m)?.[1] ?? 0,
        );
      } catch {}
    }
    const at = performance.now();
    const cpuCores = previousCpu
      ? Math.max(0, (cpu - previousCpu) / ticks / ((at - previousAt) / 1000))
      : null;
    previousCpu = cpu;
    previousAt = at;
    return {
      cpu_cores: cpuCores,
      pss_mb: +(pss / 1024).toFixed(1),
      node_rss_mb: +(process.memoryUsage().rss / 1024 / 1024).toFixed(1),
    };
  }
  await plans();
  if (httpMode) http = await (await import("./lib/wallet-http.mjs")).startWalletHttp(admin, url.href);
  let produced = 0, producing = httpMode, refreshCursor = 0;
  let stopped = false;
  let checkpoint = 10;
  const history: unknown[] = [];
  // Checkpoint writes race with snapshot installation, using the real transition-table trigger.
  const monitor = (async () => {
    while (!stopped) {
      checkpoint++;
      await admin.query(`BEGIN;
      INSERT INTO blast_infra.checkpoint_journal VALUES(${checkpoint},'mainnet','scale-digest-${checkpoint}',NULL,0,1000,1,1,''::bytea,decode(repeat('00',32),'hex'));
      INSERT INTO blast_infra.native_balance_changes VALUES(${coinSql("1")},'${owner(100000)}',${checkpoint},1,1);
      UPDATE blast_infra.balance_history_coverage SET checkpoint=${checkpoint},timestamp_ms=(extract(epoch FROM now())*1000)::bigint;
      COMMIT`);
      if (producing) {
        await admin.query(`INSERT INTO blast_infra.wallet_coin_types SELECT ${coinSql("n")} FROM generate_series($1::int,$2::int) n`, [10001+produced,10005+produced]);
        produced += 5;
        await admin.query(`UPDATE blast_infra.wallet_tracking SET next_attempt_at=now() WHERE owner >= $1 AND owner < $2 AND applied_checkpoint IS NOT NULL AND lease_until IS NULL AND attempts=0 AND snapshot_cursor IS NULL`, [owner(98001+refreshCursor),owner(98051+refreshCursor)]);
        refreshCursor=(refreshCursor+50)%2000;
      }
      const { rows } = await admin.query(`SELECT
      (SELECT count(*)::int FROM blast_infra.wallet_tracking WHERE applied_checkpoint IS NULL) pending_wallets,
      (SELECT count(*)::int FROM blast_infra.wallet_tracking WHERE lease_until>now()) leased_wallets,
      (SELECT count(*)::int FROM blast_infra.wallet_tracking WHERE next_attempt_at<=now()) due_wallets,
      (SELECT count(*)::int FROM blast_infra.wallet_tracking WHERE refreshed_at>now()-interval '10 seconds') recently_refreshed,
      (SELECT count(*)::int FROM social_wallet_sessions WHERE last_used_at>created_at+interval '20 minutes') touched_sessions,
      (SELECT count(*)::int FROM blast_infra.hydrated_coin_metadata) metadata_attempted,
      (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database()) connections,
      (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock') lock_waiters`);
      history.push({ at: Date.now(), produced, ...rows[0], ...resources() });
      await sleep(5000);
    }
  })();
  try {
    report.phases = [];
    const duration = Number(process.env.WALLET_SCALE_HTTP_SECONDS ?? 1800);
    assert(Number.isInteger(duration) && duration >= 60 && duration <= 3600 && duration % 60 === 0);
    for (const [rate, seconds] of (httpMode ? Array.from({length:duration/60},()=>[500,60]) : [[500,60],[500,240]])) {
      const result = await phase(rate!, seconds!);
      (report.phases as unknown[]).push(result);
      report.history = history;
      save();
      if (httpMode && duration >= 1800) assertPhase(result);
    }
    producing = false;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      const { rows } = await admin.query(`SELECT
        (SELECT count(*)::int FROM blast_infra.wallet_tracking WHERE applied_checkpoint IS NULL OR next_attempt_at<=now() OR lease_until IS NOT NULL) wallets,
        (SELECT count(*)::int FROM blast_infra.hydrated_coin_metadata WHERE coin_type IN (SELECT coin_type FROM blast_infra.wallet_coin_types)) metadata,
        (SELECT count(*)::int FROM generate_series(9001,${10000+produced}) n
          LEFT JOIN blast_infra.hydrated_coin_metadata h ON h.coin_type=${coinSql("n")}
          WHERE h.coin_type IS NULL OR CASE WHEN n%10=0
            THEN h.decimals IS NOT NULL OR h.next_attempt_at-h.refreshed_at<interval '59 minutes'
            ELSE h.decimals IS DISTINCT FROM 9 OR h.symbol IS DISTINCT FROM 'C'||n OR h.name IS DISTINCT FROM 'Load Coin '||n END) incomplete_metadata`);
      if (rows[0].wallets === 0 && rows[0].metadata === 10000+produced && rows[0].incomplete_metadata === 0) break;
      await sleep(5000);
    }
    stopped = true;
    await monitor;
    const { rows } = await admin.query(`SELECT
      (SELECT count(*)::int FROM blast_infra.wallet_tracking WHERE applied_checkpoint IS NULL) pending,
      (SELECT count(*)::int FROM blast_infra.wallet_tracking WHERE next_attempt_at<=now() OR lease_until IS NOT NULL) outstanding_wallets,
      (SELECT count(*)::int FROM blast_infra.wallet_balances) balances,
      (SELECT count(*)::int FROM blast_infra.hydrated_coin_metadata) metadata,
      (SELECT count(*)::int FROM blast_infra.hydrated_coin_metadata WHERE decimals IS NULL) absent,
      (SELECT count(*)::int FROM blast_infra.wallet_snapshot_coins) partial`);
    report.final = rows[0];
    report.prepared_plans = (await pool.query("SELECT name, generic_plans::int, custom_plans::int, left(statement,100) AS sql FROM pg_prepared_statements")).rows;
    console.log("FINAL", JSON.stringify(rows[0]));
    assert.equal(rows[0].pending, 0);
    assert.equal(rows[0].outstanding_wallets, 0);
    assert.equal(rows[0].balances, 500000);
    const delta = await admin.query(
      "SELECT balance::text FROM blast_infra.wallet_balances WHERE owner=$1 AND coin_type=$2",
      [owner(100000), owner(1) + loadCoinSuffix],
    );
    assert.equal(delta.rows[0].balance, String(1000000000 + checkpoint - 10));
    assert.equal(rows[0].metadata, 10000+produced);
    assert.equal(rows[0].absent, 100+Math.floor(produced/10));
    assert.equal(rows[0].partial, 0);
    const wrong =
      await admin.query(`SELECT count(*)::int AS count FROM generate_series(9001,${10000+produced}) n
      JOIN blast_infra.hydrated_coin_metadata h ON h.coin_type=${coinSql("n")}
      WHERE CASE WHEN n%10=0 THEN h.decimals IS NOT NULL OR h.next_attempt_at-h.refreshed_at<interval '59 minutes'
        ELSE h.decimals IS DISTINCT FROM 9 OR h.symbol IS DISTINCT FROM 'C'||n OR h.name IS DISTINCT FROM 'Load Coin '||n END`);
    assert.equal(wrong.rows[0].count, 0);
    const synced = http ? await http.read(50000, 0) : await assemblePortfolio({
      db,
      accountId: account(50000),
      addresses: await readAccountAddresses(db, account(50000)),
      now: Date.now,
    });
    assert.deepEqual(synced.unavailable, []);
    assert.equal(synced.wallet_sync?.status, "ready");
    assert.equal(synced.coins?.length, 10);
    const unknown = synced.coins?.find((c) =>
      c.coin_type.startsWith(owner(10000) + "::"),
    );
    assert(unknown);
    assert.equal(unknown.decimals, null);
    assert.equal(unknown.symbol, "Coin");
    assert.equal(unknown.balance, "1000000000");
    for (const p of report.phases as Awaited<ReturnType<typeof phase>>[]) assertPhase(p);
  } finally {
    stopped = true;
    await monitor;
    await http?.close();
    report.history = history;
    if (httpMode) report.query_stats = (await admin.query(`SELECT calls, total_plan_time, total_exec_time, mean_exec_time, rows, left(query,500) AS query FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) ORDER BY total_exec_time DESC LIMIT 15`)).rows;
    save();
  }
}
try {
  await (
    { seed, plans, bench }[process.argv[2] ?? ""] ??
    (() => {
      throw Error("seed|plans|bench required");
    })
  )();
} finally {
  await Promise.all([pool.end(), admin.end()]);
}
