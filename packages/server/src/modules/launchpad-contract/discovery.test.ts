import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { MarketDataDependencies } from "@blast/core/modules/read-routing/market-data.ts";
import { CursorError, decodeCursor, encodeCursor } from "@blast/core/modules/launchpad-contract/cursor.ts";
import { ContractViolation } from "@blast/core/modules/launchpad-contract/decimal.ts";
import {
  DISCOVERY_CURSORS,
  DISCOVERY_VIEWS,
  discoveryPath,
  discoveryPosition,
  launchProgressBps,
  parseDiscoveryPage,
  parseLaunchSummary,
  readDiscoveryPage,
} from "@blast/core/modules/launchpad-contract/discovery.ts";
import { FIXTURE_TIMESTAMP_MS, infraProvenanceFixture, launchSummaryFixture } from "../../../test/fixtures/modules/launchpad-contract/fixtures.ts";
import { parseInfraProvenance } from "@blast/core/modules/launchpad-contract/provenance.ts";

const ORIGIN = "https://api.blast.test";
const pad = (value: number | bigint) => String(value).padStart(20, "0");
const launchId = (byte: string) => `0x${byte.repeat(64)}`;

/** A launch row of `view`'s order: its id byte, created position, key facts. */
function launch(byte: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const summary = launchSummaryFixture();
  return {
    ...summary,
    pool_key: `blast_curve:${launchId(byte)}`,
    pool_id: launchId(byte),
    ...overrides,
  };
}

function reserves(quoteReserve: string, graduationTarget = "3000000000000"): Record<string, unknown> {
  const inputs = launchSummaryFixture().inputs as Record<string, unknown>;
  return { inputs: { ...inputs, quote_reserve: quoteReserve, graduation_target: graduationTarget } };
}

function page(pools: unknown[], nextCursor: string | null = null): Record<string, unknown> {
  return { provenance: infraProvenanceFixture(), pools, next_cursor: nextCursor };
}

function blastInfra(reply: () => Response | Promise<Response>, seen: string[] = []): MarketDataDependencies {
  return {
    origin: ORIGIN,
    now: () => FIXTURE_TIMESTAMP_MS + 412,
    timeoutMs: 1_000,
    statusCacheMs: 0,
    expected: null,
    fetch: async (input: string | URL | Request) => {
      const path = String(input).slice(ORIGIN.length);
      if (path === "/v1/status") return Response.json({ provenance: infraProvenanceFixture() });
      seen.push(path);
      return reply();
    },
  };
}

test("a launch row parses to exact integers and keeps unavailable facts null", () => {
  const row = parseLaunchSummary(launchSummaryFixture());
  assert.equal(row.launchId, "0xa1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4");
  assert.equal(row.lifecycle, "live");
  assert.equal(row.createdCursor, "325874009:1:2:0");
  assert.equal(row.createdAtMs, 1_790_200_000_000);
  assert.equal(row.publicStartMs, 1_790_200_000_000n);
  assert.deepEqual(row.partner, {
    partnerId: "0x00000000000000000000000000000000000000000000000000000000000000bb",
    status: "admitted",
    acceptedUntilMs: null,
  });
  assert.equal(row.migration, null);
  assert.equal(row.economics.inputs.quoteReserve, 260_000_000_000n);
  assert.equal(row.metadata?.symbol, "FROGGY");

  // No metadata, no trade yet (Meme reserve unknown), not shared: still a launch.
  const inputs = launchSummaryFixture().inputs as Record<string, unknown>;
  const bare = parseLaunchSummary({
    ...launchSummaryFixture(),
    launch: { ...(launchSummaryFixture().launch as object), partner_id: null },
    metadata: null,
    public_start_ms: null,
    partner: null,
    price: null,
    market_cap: null,
    inputs: { ...inputs, meme_reserve: null, quote_reserve: "0" },
  });
  assert.deepEqual([bare.metadata, bare.publicStartMs, bare.partner, bare.economics.inputs.memeReserve], [null, null, null, null]);

  const migrated = parseLaunchSummary({
    ...launchSummaryFixture(),
    lifecycle: "migrated",
    migration: {
      cursor: "326000000:2:7:0",
      timestamp_ms: 1_790_230_000_000,
      meme: "200000000000000",
      quote: "2940000000000",
      disposed_meme: "0",
      total_supply_after: "1000000000000000",
      pool_key: null,
      allocations: [
        { cursor: "326000000:2:5:0", destination: `0x${"b1a5".padStart(64, "0")}`, meme: "10000000", quote: "60000000000" },
      ],
    },
  });
  assert.equal(migrated.migration?.quote, 2_940_000_000_000n);
  assert.equal(migrated.migration?.allocations[0].quote, 60_000_000_000n);
});

test("a launch row that breaks the wire contract is refused, never read as zero", () => {
  const summary = launchSummaryFixture();
  for (const [field, value] of [
    ["public_start_ms", 1_790_200_000_000],
    ["venue", "cetus"],
    ["lifecycle", "active"],
    ["created_cursor", "1:2:3"],
    ["created_at_ms", "1790200000000"],
    ["partner", { partner_id: "0xbb", status: "admitted", accepted_until_ms: null }],
    ["partner", { ...(summary.partner as object), status: "trusted" }],
    ["partner", { ...(summary.partner as object), accepted_until_ms: 5 }],
    ["migration", { cursor: "1:1:1:0" }],
    ["launch", null],
    // A partner other than the one the launch names.
    ["partner", { ...(summary.partner as object), partner_id: `0x${"c".repeat(64)}` }],
    // A migration before the launch migrated.
    ["migration", { cursor: "1:1:1:0", timestamp_ms: 1, meme: "1", quote: "1", disposed_meme: "0", total_supply_after: "1", pool_key: null, allocations: [] }],
  ] as const) {
    assert.throws(() => parseLaunchSummary({ ...summary, [field]: value }), ContractViolation, field);
  }
});

test("progress comes from the SDK over the raw inputs", () => {
  const live = parseLaunchSummary(launchSummaryFixture());
  // floor(260e9 * 10_000 / 3e12)
  assert.equal(launchProgressBps(live), 866n);
  const ready = parseLaunchSummary({ ...launchSummaryFixture(), lifecycle: "migration_ready" });
  assert.equal(launchProgressBps(ready), 10_000n);
});

test("each view's position is its key and 20-digit native tie-break", () => {
  const row = parseLaunchSummary(launchSummaryFixture());
  assert.deepEqual(discoveryPosition("new", row), {
    key: [1_790_200_000_000],
    tie: [pad(325_874_009), pad(1), pad(2)],
  });
  assert.deepEqual(discoveryPosition("near_graduation", row), {
    key: ["2740000000000"],
    tie: [pad(325_874_009), pad(1), pad(2)],
  });
  // Past the target it saturates at 0; not yet public, or unknown target: not near graduation.
  const over = parseLaunchSummary({ ...launchSummaryFixture(), lifecycle: "migration_ready", ...reserves("3100000000000") });
  assert.deepEqual(discoveryPosition("near_graduation", over)?.key, ["0"]);
  const opening = parseLaunchSummary({ ...launchSummaryFixture(), lifecycle: "opening_round" });
  assert.equal(discoveryPosition("near_graduation", opening), null);
  const noTarget = parseLaunchSummary({ ...launchSummaryFixture(), ...reserves("0", "0") });
  assert.equal(discoveryPosition("near_graduation", noTarget), null);
  assert.equal(discoveryPosition("graduated", row), null);
});

test("blast-infra's page token is the shared cursor envelope, byte for byte", () => {
  // The token blast-infra's discovery tests pin for this position.
  const token =
    "eyJ2IjoxLCJzIjoicG9vbHM6bmV3IiwiayI6WzE3OTAyMzUwNjEyMThdLCJ0IjpbIjAwMDAwMDAwMDAwMzI2Mjc0MDA5IiwiMDAwMDAwMDAwMDAwMDAwMDAwMDMiLCIwMDAwMDAwMDAwMDAwMDAwMDAxMiJdfQ";
  const position = decodeCursor(token, DISCOVERY_CURSORS.new);
  assert.deepEqual(position, { key: [1_790_235_061_218], tie: [pad(326_274_009), pad(3), pad(12)] });
  assert.equal(encodeCursor(DISCOVERY_CURSORS.new, position.key, position.tie), token);
  assert.throws(() => decodeCursor(token, DISCOVERY_CURSORS.graduated), CursorError);
});

test("a page is checked for eligibility, exact order and its next cursor", () => {
  const first = launch("a", reserves("2900000000000"));
  const second = launch("b", reserves("2000000000000"));
  const third = launch("c", { ...reserves("2000000000000"), created_cursor: "325874010:1:0:0" });
  const shape = DISCOVERY_CURSORS.near_graduation;
  const next = encodeCursor(shape, ["1000000000000"], [pad(325_874_010), pad(1), pad(0)]);

  const parsed = parseDiscoveryPage("near_graduation", page([first, second, third], next));
  assert.deepEqual(parsed.launches.map((row) => row.launchId), [launchId("a"), launchId("b"), launchId("c")]);
  assert.equal(parsed.nextCursor, next);

  for (const [what, body] of [
    ["out of order", page([second, first])],
    ["a repeated position", page([first, first])],
    ["an opening round", page([launch("d", { lifecycle: "opening_round" })])],
    ["a venue pool", page([{ ...first, venue: "cetus" }])],
    ["a cursor that is not the last row's", page([first, second, third], encodeCursor(shape, ["1"], [pad(1), pad(1), pad(0)]))],
    ["a cursor of another view", page([first], encodeCursor(DISCOVERY_CURSORS.new, [1], [pad(1), pad(1), pad(0)]))],
    ["more rows than a page holds", page(Array.from({ length: 101 }, () => first))],
    ["no provenance-level list", { ...page([first]), pools: null }],
  ] as const) {
    assert.throws(() => parseDiscoveryPage("near_graduation", body), ContractViolation, what);
  }

  // Graduated: migrated rows by migration time, newest first.
  const migrated = (byte: string, cursor: string, timestampMs: number) =>
    launch(byte, {
      lifecycle: "migrated",
      migration: {
        cursor, timestamp_ms: timestampMs, meme: "1", quote: "1", disposed_meme: "0",
        total_supply_after: "1", pool_key: null, allocations: [],
      },
    });
  const graduated = parseDiscoveryPage("graduated", page([migrated("e", "20:2:3:0", 5_000), migrated("f", "20:1:3:0", 5_000)]));
  assert.equal(graduated.launches.length, 2);
  assert.throws(
    () => parseDiscoveryPage("graduated", page([migrated("e", "20:1:3:0", 5_000), migrated("f", "20:2:3:0", 5_000)])),
    ContractViolation,
  );
  assert.throws(() => parseDiscoveryPage("graduated", page([launch("g", { lifecycle: "migrated", migration: null })])), ContractViolation);
});

test("the request path takes a bounded limit and only its view's cursor", () => {
  assert.equal(discoveryPath("new", {}), "/v1/pools?view=new&limit=25");
  const token = encodeCursor(DISCOVERY_CURSORS.graduated, [5], [pad(1), pad(1), pad(0)]);
  assert.equal(
    discoveryPath("graduated", { limit: "100", cursor: token }),
    `/v1/pools?view=graduated&limit=100&cursor=${token}`,
  );
  for (const limit of ["0", "101", "", "-1", "2.5", "many", "99999999999999999999"]) {
    assert.throws(() => discoveryPath("new", { limit }), CursorError, limit);
  }
  assert.throws(() => discoveryPath("new", { cursor: token }), CursorError);
  assert.throws(() => discoveryPath("new", { cursor: "not a token" }), CursorError);
  assert.equal(discoveryPath("new", { limit: "3" }, { default: 2, max: 3 }), "/v1/pools?view=new&limit=3");
  assert.throws(() => discoveryPath("new", { limit: "4" }, { default: 2, max: 3 }), CursorError);
});

test("a discovery read is fresh, stale under lag with the same rows, and unavailable on failure", async () => {
  const body = page([launch("a")]);
  const seen: string[] = [];
  const fresh = await readDiscoveryPage("near_graduation", {}, blastInfra(() => Response.json(body), seen));
  if (fresh.status !== "fresh" || fresh.data.kind !== "answer") return assert.fail(JSON.stringify(fresh));
  assert.deepEqual(seen, ["/v1/pools?view=near_graduation&limit=25"]);
  assert.equal(fresh.data.value.launches[0].launchId, launchId("a"));

  const lagging = { ...body, provenance: infraProvenanceFixture({ observed_ms: FIXTURE_TIMESTAMP_MS + 45_000, lag_ms: 45_000 }) };
  const stale = await readDiscoveryPage("near_graduation", {}, blastInfra(() => Response.json(lagging)));
  if (stale.status !== "stale" || stale.data.kind !== "answer") return assert.fail(JSON.stringify(stale));
  assert.deepEqual(stale.data.value.launches, fresh.data.value.launches);
  assert.equal(stale.provenance.lagMs, 45_000);

  for (const [reason, reply] of [
    ["unreachable", () => Promise.reject(new Error("connection refused"))],
    ["not_ready", () => Response.json({ error: { code: "not_ready", message: "engine is starting" } }, { status: 503 })],
    ["contract-violation", () => Response.json(page([launch("a", { public_start_ms: 1 })]))],
  ] as const) {
    const result = await readDiscoveryPage("near_graduation", {}, blastInfra(reply as () => Promise<Response>));
    assert.deepEqual({ status: result.status, reason: result.provenance.reason, data: "data" in result }, {
      status: "unavailable", reason, data: false,
    });
  }

  const refused = await readDiscoveryPage(
    "new",
    {},
    blastInfra(() => Response.json({ error: { code: "invalid_parameter", message: "limit" } }, { status: 400 })),
  );
  if (refused.status === "unavailable") return assert.fail(JSON.stringify(refused));
  assert.deepEqual(refused.data, { kind: "refused", httpStatus: 400, error: { code: "invalid_parameter", message: "limit" } });
});

test("recorded discovery pages in the current wire shape parse in each view's exact order", () => {
  const launches = new Set<string>();
  for (const view of DISCOVERY_VIEWS) {
    const body = JSON.parse(readFileSync(new URL(`../../../../core/test/fixtures/modules/launchpad-contract/fixtures/v1-discovery-${view}.json`, import.meta.url), "utf8"));
    const page = parseDiscoveryPage(view, body);
    assert.equal(parseInfraProvenance(body.provenance).network, "localnet", view);
    assert.equal(page.launches.length, 2, view);
    assert.equal(page.nextCursor, null, view);
    for (const launch of page.launches) {
      launches.add(launch.launchId);
      const { quoteReserve, graduationTarget } = launch.economics.inputs;
      const expected = view === "near_graduation" ? (quoteReserve! * 10_000n) / graduationTarget! : 10_000n;
      assert.equal(launchProgressBps(launch), expected, `${view} ${launch.launchId}`);
    }
    if (view === "graduated") {
      assert.ok(page.launches.every((launch) => launch.migration !== null && launch.lifecycle === "migrated"));
    }
  }
  assert.equal(launches.size, 2);
});
