import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";

import { CREATE_SUI_QUOTE_TYPE, CREATE_TEST_SUI_QUOTE_TYPE } from "@blast/core/modules/social/contracts/create.ts";
import { chainPriceOf } from "@blast/core/modules/social/prices/keyed.ts";
import { displayPriceOf, displayPricesIn } from "@blast/core/modules/social/prices/test-sui.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;

type PlanNode = { "Node Type": string; "Relation Name"?: string; "Actual Rows"?: number; "Actual Loops"?: number; "Plan Rows": number; Plans?: PlanNode[] };

const PAGE = ["coin-1", "coin-2", "coin-3", "coin-4", CREATE_TEST_SUI_QUOTE_TYPE];

/** A page of coins priced through every keyed helper, the way Home's facts read them. */
const PAGE_SQL = `SELECT k.coin, pr.usd_price::text AS display, cp.usd_price::text AS chain
  FROM unnest($1::text[]) WITH ORDINALITY k(coin, n)
  LEFT JOIN ${displayPriceOf("k.coin")} pr ON TRUE
  LEFT JOIN ${chainPriceOf("k.coin")} cp ON TRUE
  ORDER BY k.n`;

function nodes(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

function touchesPrices(plan: PlanNode): boolean {
  return nodes(plan).some((node) => node["Relation Name"] === "prices");
}

test("keyed price reads probe the page's coins, not every priced coin", { skip: !databaseUrl }, async (t) => {
  const database = await freshTestDatabase();
  const client = new pg.Client({ connectionString: database.url });
  await client.connect();
  t.after(async () => {
    await client.end();
    await database.drop();
  });
  const seed = (from: number, to: number) => client.query(
    `INSERT INTO blast_infra_fixture.prices
     SELECT 'coin-' || i, i, (extract(epoch FROM now()) * 1000)::bigint, 'pool' FROM generate_series($1::int, $2::int) i`, [from, to]);
  await client.query("INSERT INTO blast_infra_fixture.prices VALUES ($1, 3.5, (extract(epoch FROM now()) * 1000)::bigint, 'pyth')", [CREATE_SUI_QUOTE_TYPE]);

  const measure = async (probesOnly: boolean) => {
    await client.query("ANALYZE blast_infra_fixture.prices");
    const [{ "QUERY PLAN": [{ Plan: root }] }] = (await client.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${PAGE_SQL}`, [PAGE])).rows;
    const plan = root as PlanNode;
    const priceNodes = nodes(plan).filter((node) => node["Relation Name"] === "prices");
    assert.ok(priceNodes.length > 0, "no node reads the price table");
    // At 2,000 coins a per-row Seq Scan would grow with N while each loop still returns one row.
    if (probesOnly) for (const node of priceNodes) assert.match(node["Node Type"], /^Index (Only )?Scan$/, `${node["Node Type"]} on prices is not a key probe`);
    for (const node of nodes(plan)) {
      assert.ok(!(/^(Hash|Merge Join|Materialize|Sort)/.test(node["Node Type"]) && touchesPrices(node)), `${node["Node Type"]} over the price list`);
    }
    assert.ok(plan["Plan Rows"] <= PAGE.length * 2, `estimate ${plan["Plan Rows"]} for ${PAGE.length} coins`);
    return priceNodes.map((node) => (node["Actual Rows"] ?? 0) * (node["Actual Loops"] ?? 0));
  };

  await seed(1, 200);
  const small = await measure(false);
  await seed(201, 2_000);
  const large = await measure(true);
  assert.deepEqual(large, small, "the price reads grew with the priced coins");

  const keyed = (await client.query(PAGE_SQL, [PAGE])).rows;
  const joined = (await client.query(`SELECT k.coin, pr.usd_price::text AS display, cp.usd_price::text AS chain
    FROM unnest($1::text[]) WITH ORDINALITY k(coin, n)
    LEFT JOIN ${displayPricesIn("$1::text[]")} pr ON pr.coin_type = k.coin
    LEFT JOIN chain_read_v1.prices cp ON cp.coin_type = k.coin ORDER BY k.n`, [PAGE])).rows;
  assert.deepEqual(keyed, joined);
  assert.equal(keyed.at(-1)?.display, "3.5");
});

test("the display prices hold one row per coin type, so a keyed LIMIT 1 drops nothing", { skip: !databaseUrl }, async (t) => {
  const database = await freshTestDatabase();
  const client = new pg.Client({ connectionString: database.url });
  await client.connect();
  t.after(async () => {
    await client.end();
    await database.drop();
  });
  await client.query(`INSERT INTO blast_infra_fixture.prices VALUES
    ($1, 3.5, (extract(epoch FROM now()) * 1000)::bigint, 'pyth'), ($2, 9, (extract(epoch FROM now()) * 1000)::bigint, 'pool'),
    ('coin-1', 2, (extract(epoch FROM now()) * 1000)::bigint, 'pool')`, [CREATE_SUI_QUOTE_TYPE, CREATE_TEST_SUI_QUOTE_TYPE]);
  const { rows: [counts] } = await client.query(
    `SELECT count(*)::int AS n, count(DISTINCT coin_type)::int AS unique_types FROM ${displayPricesIn("$1::text[]")} dp`,
    [[CREATE_SUI_QUOTE_TYPE, CREATE_TEST_SUI_QUOTE_TYPE, "coin-1"]]);
  assert.deepEqual(counts, { n: 3, unique_types: 3 });
});
