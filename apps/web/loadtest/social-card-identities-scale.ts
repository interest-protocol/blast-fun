// Disposable launch-scale verification. Run from apps/web with SOCIAL_SCALE_DATABASE_URL:
// node --import ../../scripts/test-tsx-hooks.mjs --experimental-strip-types loadtest/social-card-identities-scale.ts seed|bench|http
// `http` also requires CARD_IDENTITY_APP_URL pointing to a local `next start` with social enabled.
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool, createRuntimePool, poolSettingsFromEnvironment } from "@blast/core/modules/database/pool.ts";
import { CHAIN_FIXTURE, resetSharedDatabase, urlAs } from "../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { makeSeasonZeroCardFixtures } from "../../../packages/server/test/fixtures/modules/mission-control/card-renderer/fixtures.ts";
import { readCardIdentities } from "@blast/server/modules/social/card-identity/read.ts";
import { seedCardIdentities } from "../../../packages/server/test/fixtures/modules/social/card-identity/testing.ts";
import { CARD_IDENTITY_PATH } from "@blast/core/modules/social/contracts/card-identity.ts";
import { assertLoadTestDatabaseUrl } from "./lib/env.mjs";

const databaseUrl = process.env.SOCIAL_SCALE_DATABASE_URL ?? "";
assertLoadTestDatabaseUrl(databaseUrl);
const ACCOUNTS = 10_000, CARDS = 9_985, RUNS = 50, SECONDS = 30;
const RATE = Number(process.env.SOCIAL_SCALE_RATE ?? "200");
assert.ok(Number.isInteger(RATE) && RATE >= 1 && RATE <= 200, "SOCIAL_SCALE_RATE must be an integer from 1 to 200");
const callsigns = (request: number, size = 50) => Array.from({ length: size }, (_, i) => `crew_scale_${1 + (request * 97 + i) % ACCOUNTS}`).sort();
const id = (prefix: number) => `('${prefix}0000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid`;
function summary(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction: number) => Number(sorted[Math.ceil(sorted.length * fraction) - 1]!.toFixed(2));
  return { requests: sorted.length, p50_ms: at(0.5), p95_ms: at(0.95), max_ms: at(1) };
}

async function seed() {
  const admin = createPool(databaseUrl, { max: 2 });
  try {
    await resetSharedDatabase(admin);
    await admin.query(CHAIN_FIXTURE);
    await migrateDatabase(admin);
    await seedCardIdentities(admin);
    const fixture = (await makeSeasonZeroCardFixtures()).find(({ record }) => record.edition === "recruit");
    if (!fixture) throw new Error("Recruit card fixture is required.");
    const sample = fixture.record;
    await admin.query(`INSERT INTO mission_control_profiles
      (profile_id, privy_did, x_subject, sui_address, provider_wallet_reference, callsign, display_name, disclosure_version, disclosure_accepted_at)
      SELECT ${id(0)}, 'did:privy:crew-scale-' || n, 'crew-scale-' || n,
        '0x' || lpad('cafe' || to_hex(n), 64, '0'), 'crew-scale-' || n, 'crew_scale_' || n,
        'Crew ' || n, 'fixture-v1', now() FROM generate_series(1, ${ACCOUNTS}) n`);
    await admin.query(`INSERT INTO mission_control_season_memberships
      (membership_id, allocation_id, card_id, season_id, profile_id, crew_number, fleet, owner_title, zero_fleet, gold)
      SELECT ${id(2)}, ${id(3)}, ${id(1)}, 'season-zero', ${id(0)}, 10000 + n,
        'Recon', 'Recon Fleet', false, false FROM generate_series(1, ${CARDS}) n`);
    await admin.query(`INSERT INTO mission_control_cards
      (card_id, profile_id, membership_id, record_schema, record_version, card_record, created_at, published_at)
      SELECT ${id(1)}, ${id(0)}, ${id(2)}, $2, $3,
        $1::jsonb || jsonb_build_object('cardId', ${id(1)}, 'callsign', 'crew_scale_' || n, 'crew', 10000 + n),
        now(), CASE WHEN n % 3 = 0 THEN NULL ELSE now() END FROM generate_series(1, ${CARDS}) n`,
    [JSON.stringify(sample), sample.schema, sample.version]);
    await admin.query("VACUUM ANALYZE");
    console.log(`Seeded ${ACCOUNTS} accounts plus 14 edition fixtures: 9,999 cards (the season capacity) and 15 non-cardholders.`);
  } finally { await admin.end(); }
}

async function bench() {
  const pool = createRuntimePool(urlAs(databaseUrl, "blast_web"), poolSettingsFromEnvironment(), "card-identity-scale");
  try {
    const reader = autocommitReader(pool, "social");
    let statement = "";
    const capture: ReadableDatabase = { read(text, values) { statement = text; return reader.read(text, values); } };
    await readCardIdentities(capture, callsigns(0));
    const results = [];
    fs.mkdirSync("loadtest/results", { recursive: true });
    const plans = [];
    for (const size of [1, 50]) {
      const times = [];
      for (let run = 0; run < RUNS + 3; run++) {
        const result = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`, [callsigns(run, size)]);
        const plan = result.rows[0]["QUERY PLAN"][0];
        const text = JSON.stringify(plan);
        if (text.includes('"Node Type":"Seq Scan"')) fs.writeFileSync("loadtest/results/social-card-identities-unindexed-plan.json", JSON.stringify(plan, null, 2));
        assert.ok(!text.includes('"Node Type":"Seq Scan"'), "card identities must use indexes at launch scale");
        if (run >= 3) times.push(plan["Planning Time"] + plan["Execution Time"]);
        if (run === 3) plans.push({ size, plan });
      }
      results.push({ batch_size: size, ...summary(times) });
    }
    fs.writeFileSync("loadtest/results/social-card-identities-scale.json", JSON.stringify({ results, plans }, null, 2));
    console.log(JSON.stringify(results));
  } finally { await pool.end(); }
}

async function http() {
  const appUrl = process.env.CARD_IDENTITY_APP_URL ?? "";
  if (!URL.canParse(appUrl)) throw new Error("CARD_IDENTITY_APP_URL must be a valid loopback URL.");
  const origin = new URL(appUrl);
  assert.ok(origin.protocol === "http:" && ["127.0.0.1", "localhost"].includes(origin.hostname), "HTTP load runs only on loopback");
  const page = await fetch(new URL("/privacy", origin));
  assert.equal(page.status, 200);
  const cookie = page.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
  assert.ok(cookie.includes("blast_gate="), "prime the real API gate");
  const samples: number[] = [];
  const started = performance.now();
  // Schedule arrivals independently: waiting for each second's responses creates catch-up bursts.
  await Promise.all(Array.from({ length: RATE * SECONDS }, async (_, n) => {
    await delay(Math.max(0, started + n * 1000 / RATE - performance.now()));
    const names = callsigns(n);
    if (n % 10 === 0) names[0] = `missing_crew_${n}`;
    const url = new URL(CARD_IDENTITY_PATH, origin);
    url.searchParams.set("callsigns", names.join(","));
    const before = performance.now();
    const response = await fetch(url, { headers: { cookie, "x-forwarded-for": `10.0.${Math.floor(n / 250)}.${n % 250 + 1}` }, signal: AbortSignal.timeout(15_000) });
    if (response.status !== 200) throw new Error(`Card identity read answered ${response.status}.`);
    assert.equal(response.headers.get("cache-control"), "public, s-maxage=10, stale-while-revalidate=20");
    assert.equal(response.headers.get("set-cookie"), null);
    const body = await response.json();
    assert.equal(Object.keys(body).length, 50);
    for (const callsign of names) {
      if (callsign.startsWith("missing_")) { assert.equal(body[callsign], null); continue; }
      const owner = Number(callsign.slice("crew_scale_".length));
      if (owner > CARDS) { assert.equal(body[callsign], null); continue; }
      assert.equal(body[callsign].crew, 10000 + owner);
      assert.equal(body[callsign].edition, "recruit");
      assert.equal(body[callsign].published_card_id === null, owner % 3 === 0);
    }
    samples.push(performance.now() - before);
  }));
  const result = { ...summary(samples), elapsed_seconds: (performance.now() - started) / 1000 };
  const measured = { ...result, scheduled_requests_per_second: RATE, requests_per_second: samples.length / result.elapsed_seconds };
  fs.mkdirSync("loadtest/results", { recursive: true });
  fs.writeFileSync("loadtest/results/social-card-identities-http.json", JSON.stringify(measured, null, 2));
  console.log(JSON.stringify(measured));
  assert.ok(result.p95_ms < 300, "origin p95 must stay under 300 ms");
  assert.ok(measured.requests_per_second >= RATE * 0.95, "origin must sustain the requested arrival rate");
}

switch (process.argv[2]) {
  case "seed": await seed(); break;
  case "bench": await bench(); break;
  case "http": await http(); break;
  default: throw new Error("Use seed, bench or http.");
}
