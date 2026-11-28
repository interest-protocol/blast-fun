import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import type { QueryResultRow } from "pg";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { createReadCache } from "@blast/server/modules/social/read-cache.ts";
import { parseTradersQuery, readHomeTraders, type TraderPortfolioRead, readTraderPortfolios } from "@blast/server/modules/social/home/traders.ts";

/** Instrument database work without making elapsed-time assertions on a shared host. */
function fixture(count: number, publicCount = count) {
  const ids = Array.from({ length: count }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
  const callsign = (id: string) => `trader${ids.indexOf(id).toString().padStart(3, "0")}`;
  let active = 0;
  let peak = 0;
  let ledgerReads = 0;
  let holdingsReads = 0;
  let detailReads = 0;
  let detailAccounts: readonly string[] = [];
  const walletAccounts: string[] = [];
  const query = async (sql: string, values: readonly unknown[] = []): Promise<QueryResultRow[]> => {
    if (sql.includes("FROM chain_read_v1.blast_pnl_period")) return [{ first_checkpoint: "1" }];
    if (sql.includes("FROM chain_read_v1.watermark")) return [{ market_checkpoint: "1", market_timestamp_ms: "1000", presale_checkpoint: "1", presale_timestamp_ms: "1000", observed_ms: "1000" }];
    if (sql.includes("FROM social_accounts a JOIN social_account_identities i")) return ids.slice(0, publicCount).map((id) => ({ account_id: id }));
    if (sql.includes("AS coins_total")) return ids.map((id) => ({ sale: "", who: `a:${id}`, account_id: id, wallet: id, events_total: "1", latest_ms: "1000", latest_kind: "trade_buy", coins_total: 1 }));
    if (sql.includes("FROM social_account_identities")) return ids.map((id) => ({ account_id: id, callsign: callsign(id), display_name: null, avatar_url: null, x_handle: null, verified: false }));
    if (sql.includes("FROM social_follows")) return [];
    if (sql.includes("a.portfolio_public")) return ids.slice(0, publicCount).map((id) => ({ account_id: id }));
    if (sql.includes("WHERE w.who = ANY")) {
      detailReads++;
      const whos = values.find((value): value is string[] => Array.isArray(value) && value.some((who) => ids.includes(String(who).slice(2)))) ?? [];
      detailAccounts = whos.map((who) => who.slice(2));
      return [];
    }
    if (sql.includes("CROSS JOIN LATERAL") && sql.includes("FROM chain_read_v1.blast_pnl_activity a")) {
      ledgerReads++;
      active++;
      peak = Math.max(peak, active);
      await setImmediate();
      active--;
      return [];
    }
    if (sql.includes("wallet_balances")) {
      holdingsReads++;
      await setImmediate();
      return (JSON.parse(values[0] as string) as { account_id: string; addresses: string[] }[]).map((row) => ({ account_id: row.account_id, owner: row.addresses[0], status: "ready", checkpoint: "1", timestamp_ms: "1000", coin_type: "0x1::c::C", balance: "1", name: null, symbol: null, decimals: 0, icon_url: null, presale_id: "c", launch_id: null, usd_price: null, as_of_ms: null, price_unavailable: false }));
    }
    throw new Error(`Unexpected query: ${sql}`);
  };
  const db: ReadableDatabase = {
    async read<Row extends QueryResultRow>(sql: string, values?: readonly unknown[]) {
      const rows = await query(sql, values);
      return { rows: rows as Row[], rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
    },
  };
  const wallets = { async wallets(id: string) {
    walletAccounts.push(id);
    return [{ address: id, kind: "embedded" as const, linked_at_ms: 0 }];
  } };
  return { ids, db, wallets, setPublic: (count: number) => { publicCount = count; }, metrics: () => ({ peak, ledgerReads, holdingsReads, detailReads, detailAccounts, walletAccounts }) };
}

test("100 public candidates holding a coin keep the same top ten while bounding portfolio reads and fetching only their details", async () => {
  const f = fixture(100);
  const page = await readHomeTraders(f.db, "24h", { nowMs: 1000, hiddenKinds: [], terms: null, portfolios: { db: f.db, wallets: f.wallets } }, { search: "", page: 1, limit: 10 });
  assert.deepEqual(page.traders.map((trader) => [trader.key, trader.rank, trader.portfolio.pnl_usd]), Array.from({ length: 10 }, (_, index) => [`c:trader${String(index).padStart(3, "0")}`, 1, "0.00"]));
  const metrics = f.metrics();
  assert.equal(metrics.ledgerReads, 100, "all candidates still participate in ranking");
  assert.equal(metrics.holdingsReads, 25, "holdings are batched four accounts per statement");
  assert.equal(metrics.peak, 4, "the account workers bound concurrent ledger queries");
  assert.equal(metrics.detailReads, 1);
  assert.deepEqual(metrics.detailAccounts, f.ids.slice(0, 10));
});

test("the page's sides read starts while its activity read is still running", async () => {
  const f = fixture(10);
  const events: string[] = [];
  const db: ReadableDatabase = { async read(sql, args) {
    const name = sql.includes("AS coins_total") ? "activity" : sql.includes("WHERE w.who = ANY") ? "sides" : null;
    if (name) events.push(`${name} start`);
    if (name === "activity") await setImmediate();
    const result = await f.db.read(sql, args);
    if (name) events.push(`${name} end`);
    return result as never;
  } };
  await readHomeTraders(db, "24h", { nowMs: 1000, hiddenKinds: [], terms: null, portfolios: { db, wallets: f.wallets } });
  assert.ok(events.indexOf("sides start") < events.indexOf("activity end"), events.join(", "));
});

test("private candidates never load wallets and an empty public leaderboard skips all activity details", async () => {
  const f = fixture(100, 0);
  const page = await readHomeTraders(f.db, "24h", { nowMs: 1000, hiddenKinds: [], terms: null, portfolios: { db: f.db, wallets: f.wallets } });
  assert.deepEqual(page.traders, []);
  assert.deepEqual(f.metrics(), { peak: 0, ledgerReads: 0, holdingsReads: 0, detailReads: 0, detailAccounts: [], walletAccounts: [] });
});

test("a failed portfolio read rejects the response and stops scheduling the remaining candidates", async () => {
  const f = fixture(100);
  const failure = new Error("ledger unavailable");
  let started = 0;
  await assert.rejects(readTraderPortfolios(f.db, { db: f.db, wallets: { async wallets() { started++; throw failure; } } }, f.ids, 1000), failure);
  await setImmediate();
  assert.equal(started, 4);
});


test("concurrent Home requests share accounting, but opt-out is checked again before a cache hit", async () => {
  const f = fixture(100);
  let now = 1000;
  const cache = createReadCache<ReadonlyMap<string, TraderPortfolioRead>>(10_000, 64, () => now);
  const ledger = { db: f.db, wallets: f.wallets, cache };
  const results = await Promise.all(Array.from({ length: 20 }, () => readTraderPortfolios(f.db, ledger, f.ids, now)));
  assert.equal(f.metrics().ledgerReads, 100, "twenty requests share one accounting pass");
  assert.ok(results.every((result) => result.get(f.ids[0]!)?.public));
  f.setPublic(0);
  assert.ok([...(await readTraderPortfolios(f.db, ledger, f.ids, now)).values()].every((value) => !value.public));
  assert.equal(f.metrics().ledgerReads, 100);
  f.setPublic(100);
  now += 10_001;
  await readTraderPortfolios(f.db, ledger, f.ids, now);
  assert.equal(f.metrics().ledgerReads, 200, "expired accounting is recomputed");
});


test("global ranking includes inactive accounts beyond 100; every page/search retains global ranks", async () => {
  const f = fixture(125);
  const values = new Map(f.ids.map((id, index) => [id, { public: true, pnl_usd: `${index}.00`, value_usd: "0.00", holdings: [] }]));
  const base = f.db.read.bind(f.db);
  const db: ReadableDatabase = { async read(sql, args) {
    if (sql.includes("AS coins_total")) return { rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] };
    if (sql.includes("FROM social_wallet_owners")) return { rows: (args?.[1] === "wallet" ? [{ account_id: f.ids[111] }] : []) as never, rowCount: 1, command: "SELECT", oid: 0, fields: [] };
    return base(sql, args);
  } };
  const context = { nowMs: 1000, hiddenKinds: [], terms: null, portfolios: { db, wallets: f.wallets, cache: { read: async () => values, clear() {} } } };
  const top = await readHomeTraders(db, "1h", context);
  assert.deepEqual([top.global_total, top.total, top.traders[0]?.actor.type === "account" && top.traders[0].actor.callsign, top.traders[0]?.rank], [124, 124, "trader124", 1], "trader000 ($0, no coin held) is left out");
  assert.equal(top.traders[0]?.events_total, 0, "recent activity is not required");
  const second = await readHomeTraders(db, "24h", context, { search: "", page: 2, limit: 20 });
  assert.deepEqual(second.traders.map((row) => row.rank), Array.from({ length: 20 }, (_, i) => i + 21));
  const named = await readHomeTraders(db, "24h", context, { search: "@TRADER110", page: 1, limit: 5 });
  assert.deepEqual(named.traders.map((row) => row.rank), [15], "name matches are ranked globally");
  const wallet = await readHomeTraders(db, "24h", context, { search: "wallet", page: 1, limit: 5 });
  assert.deepEqual(wallet.traders.map((row) => row.rank), [14]);
  const tail = await readHomeTraders(db, "24h", context, { search: "", page: Number.MAX_SAFE_INTEGER, limit: 20 });
  assert.deepEqual([tail.page, tail.traders.length, tail.traders[0]?.rank], [7, 4, 121]);
});

test("trader query rejects duplicate, unbounded and malformed parameters", () => {
  assert.deepEqual(parseTradersQuery(new URLSearchParams("search=%20%40Maya%20&page=2&limit=20")), { window: "24h", search: "@Maya", page: 2, limit: 20 });
  for (const input of ["page=0", "page=-1", "page=1.5", "page=9007199254740992", "limit=0", "limit=51", "limit=x", "search=a&search=b", "page=1&page=2", "limit=5&limit=10", `search=${"x".repeat(129)}`]) {
    assert.throws(() => parseTradersQuery(new URLSearchParams(input)), { code: "invalid_parameter" }, input);
  }
});
