import assert from "node:assert/strict";
import test from "node:test";
import { DefillamaAccounting } from "./accounting.ts";
import { createDefillamaRead } from "./reads.ts";
import { DefillamaError, METHODOLOGY } from "./contracts.ts";
import type { Publication, ReportingReads } from "./store.ts";
import { day, end, profile, start } from "./fixtures.test.ts";

export const publication: Publication = {
  id: "a".repeat(64),
  revision: 1,
  published_at: new Date(end + 1000),
  summary: {
    schema_version: 1,
    chain: "sui",
    date: day,
    start_timestamp: start / 1000,
    end_timestamp: end / 1000,
    methodology_version: METHODOLOGY,
    profile,
    source: {
      checkpoint: "105",
      digest: "verified-checkpoint",
      timestamp_ms: end,
      history_start_ms: start - 3000,
    },
    coverage: new DefillamaAccounting(profile, start, end).result().coverage,
    scope_coverage: new DefillamaAccounting(profile, start, end).result().scope_coverage,
    frontend_fee_coverage: { status: "complete", reason: null },
    frontend_fee_policy: [],
  },
};

test("daily pages pin revision, selector and integer cursor without losing atomic precision", async () => {
  let latest = publication;
  const pins: (string | undefined)[] = [];
  const store: ReportingReads = {
    feeHours: async () => new Map(),
    publications: async () => ({ latest, days: [] }),
    publication: async (_selector, snapshot) => {
      pins.push(snapshot);
      return snapshot ? publication : latest;
    },
    page: async (_id, _table, after) =>
      Array.from({ length: after < 0 ? 101 : 1 }, (_, i) => ({
        ordinal: after + i + 1,
        payload: { amount: "9007199254740993" },
      })),
  };
  const read = createDefillamaRead(
    () => store,
    () => end + 1000,
  );
  const first = await read(
    new Request(`https://www.blast.fun/api/v1/defillama/metrics?date=${day}`),
  );
  const body = await first.json();
  assert.equal(body.items.length, 100);
  assert.equal(body.items[0].amount, "9007199254740993");
  latest = { ...publication, id: "b".repeat(64), revision: 2 };
  const second = await read(
    new Request(
      `https://www.blast.fun/api/v1/defillama/metrics?date=${day}&cursor=${body.next_cursor}`,
    ),
  );
  const next = await second.json();
  assert.equal(next.snapshot_id, publication.id);
  assert.equal(next.revision, 1);
  assert.equal(next.next_cursor, null);
  assert.deepEqual(pins, [undefined, publication.id]);
  const wrongDay = await read(
    new Request(
      `https://www.blast.fun/api/v1/defillama/metrics?date=2026-10-19&cursor=${body.next_cursor}`,
    ),
  );
  assert.equal(wrongDay.status, 400);
});

test("fee windows require completed UTC hours and reject missing hours", async () => {
  const read = createDefillamaRead(
    () => ({ feeHours: async () => new Map() }) as unknown as ReportingReads,
    () => end,
  );
  const request = (query: string) =>
    read(new Request(`https://test/api/v1/defillama/fees?${query}`));
  const hour = start / 1000;
  assert.equal((await request(`start_timestamp=${hour}&end_timestamp=${hour + 3600}`)).status, 404);
  assert.equal(
    (await request(`start_timestamp=${hour + 1}&end_timestamp=${hour + 3600}`)).status,
    400,
  );
  assert.equal((await request(`start_timestamp=${hour}&end_timestamp=${hour + 3601}`)).status, 400);
  assert.equal(
    (await request(`start_timestamp=${hour}&end_timestamp=${hour + 3600}&date=${day}`)).status,
    400,
  );
  assert.equal(
    (await request(`start_timestamp=${hour}&start_timestamp=${hour}&end_timestamp=${hour + 3600}`))
      .status,
    400,
  );
  assert.equal(
    (await request(`start_timestamp=${end / 1000 - 3600}&end_timestamp=${end / 1000 + 3600}`))
      .status,
    409,
  );
});

test("invalid selectors fail before storage; absence, pending days and dependency failures are distinct", async () => {
  let calls = 0;
  const read = createDefillamaRead(
    () => {
      calls++;
      throw new Error("private database credential should never leak");
    },
    () => end,
  );
  for (const query of [
    "",
    "date=2026-02-30",
    `date=${day}&date=${day}`,
    `date=${day}&limit=1000`,
    `date=${day}&cursor=%7B%7D`,
  ]) {
    const response = await read(new Request(`https://test/api/v1/defillama/metrics?${query}`));
    assert.equal(response.status, 400, query);
  }
  assert.equal(
    (await read(new Request("https://test/api/v1/defillama/metrics?date=2026-10-21"))).status,
    409,
  );
  for (const timestamp of ["-1", "1.1", "0001", "1e9", "99999999999999999999999"]) {
    assert.equal(
      (await read(new Request(`https://test/api/v1/defillama/contracts?timestamp=${timestamp}`)))
        .status,
      400,
    );
  }
  assert.equal(calls, 0);
  const failed = await read(new Request(`https://test/api/v1/defillama/metrics?date=${day}`));
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get("retry-after"), "30");
  assert.doesNotMatch(await failed.text(), /credential/);
  const missing = createDefillamaRead(
    () =>
      ({
        publication: async () => {
          throw new DefillamaError("not_published", 404);
        },
      }) as unknown as ReportingReads,
    () => end,
  );
  assert.equal(
    (await missing(new Request(`https://test/api/v1/defillama/metrics?date=${day}`))).status,
    404,
  );
});

test("metadata does not bridge missing days and discloses excluded accounting components", async () => {
  const older = { ...publication, summary: { ...publication.summary, date: "2026-10-18" } };
  const read = createDefillamaRead(
    () =>
      ({
        publications: async () => ({
          latest: publication,
          days: [publication, older].map((p) => ({
            id: p.id,
            date: p.summary.date,
            coverage: p.summary.coverage,
            published_at: p.published_at,
          })),
        }),
      }) as ReportingReads,
  );
  const response = await read(new Request("https://test/api/v1/defillama/metadata"));
  const body = await response.json();
  assert.deepEqual(body.metrics.fees.available_ranges, [
    { from: "2026-10-18", through: "2026-10-18" },
    { from: day, through: day },
  ]);
  assert.equal(body.methodology_version, METHODOLOGY);
  assert.equal(body.methodology.sell_volume, "quote_out_gross");
  assert.equal(body.components.migration.included_in_totals, true);
  assert.equal(body.components.vault_collections.included_in_totals, true);
  assert.equal(body.components.vault_collections.underlying_venue_overlap, true);
  assert.equal(body.components.migration_residuals.included_in_totals, false);
  assert.equal(body.components.frontend_router_fees.included_in_totals, true);
  assert.equal(body.components.frontend_router_fees.underlying_venue_overlap, false);
  assert.deepEqual(body.metrics_cadence, { seconds: 86400, alignment: "UTC", completed_only: true });
  assert.equal(body.metrics.holders_revenue.status, "not_applicable");
});
