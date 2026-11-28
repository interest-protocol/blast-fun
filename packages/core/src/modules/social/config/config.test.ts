import assert from "node:assert/strict";
import test from "node:test";

import type { QueryResult, QueryResultRow } from "pg";

import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { SOCIAL_CONFIG_DEFAULTS, SOCIAL_CONFIG_KEYS } from "../contracts/config.ts";
import { cachedLoader, createSocialConfigReader, SOCIAL_CONFIG_CACHE_MS } from "./reader.ts";
import {
  decodeSocialConfigValue,
  matchBlockedTerm,
  normalizeBlockedTerm,
  parseSocialConfigInput,
  parseSocialConfigKey,
  socialConfigFromRows,
} from "./values.ts";

test("T-003-AC-1 config keys: only the tuning keys are accepted", () => {
  for (const key of SOCIAL_CONFIG_KEYS) assert.equal(parseSocialConfigKey(key), key);
  for (const key of ["nope", "", "BIG_COMMIT_USD", "big_commit_usd ", "__proto__", "toString"]) {
    assert.equal(parseSocialConfigKey(key), null, key);
  }
});

test("T-003-AC-1 config values: each type accepts its form and refuses others", () => {
  const accepted: [Parameters<typeof parseSocialConfigInput>[0], string, unknown][] = [
    ["why_boost_ms", "1800000", 1_800_000],
    ["big_boost_ms", "0", 0],
    ["for_you_window_days", "30", 30],
    ["for_you_migrated_days", " 7 ", 7],
    ["big_commit_usd", "2500", "2500"],
    ["big_commit_usd", "2500.50", "2500.5"],
    ["big_trade_usd", "0.25", "0.25"],
    ["big_trade_usd", "1000.000", "1000"],
    ["participant_milestones", "100, 10,50", [10, 50, 100]],
    ["holder_milestones", "5", [5]],
    ["reactions", "rocket,fire", ["rocket", "fire"]],
    ["reactions", "a,b,c,d,e,f,g,h", ["a", "b", "c", "d", "e", "f", "g", "h"]],
    ["fastest_window_ms", "21600000", 21_600_000],
    ["recap_trading_days", "30", 30],
  ];
  for (const [key, text, value] of accepted) {
    assert.deepEqual(parseSocialConfigInput(key, text), value, `${key} ${text}`);
  }
  const refused: [Parameters<typeof parseSocialConfigInput>[0], string][] = [
    ["why_boost_ms", "abc"],
    ["why_boost_ms", "-1"],
    ["why_boost_ms", "1.5"],
    ["why_boost_ms", "1e6"],
    ["why_boost_ms", "99999999999999999999"],
    ["for_you_window_days", "0"],
    ["for_you_window_days", "3651"],
    ["big_commit_usd", "abc"],
    ["big_commit_usd", "0"],
    ["big_commit_usd", "0.000"],
    ["big_commit_usd", "-5"],
    ["big_commit_usd", "01000"],
    ["big_commit_usd", "1,000"],
    ["big_commit_usd", "1000.1234567"],
    ["big_commit_usd", ""],
    ["participant_milestones", ""],
    ["participant_milestones", "10,10"],
    ["participant_milestones", "0,10"],
    ["participant_milestones", "10,,50"],
    ["participant_milestones", "ten"],
    ["participant_milestones", Array.from({ length: 51 }, (_, index) => index + 1).join(",")],
    ["reactions", ""],
    ["reactions", "fire,fire"],
    ["reactions", "Fire"],
    ["reactions", "fire,1rocket"],
    ["reactions", "a,b,c,d,e,f,g,h,i"],
    ["reactions", "fire rocket"],
  ];
  for (const [key, text] of refused) {
    assert.equal(parseSocialConfigInput(key, text), null, `${key} ${JSON.stringify(text)}`);
  }
});

test("stored values decode by type; invalid or unknown rows fall back to the initial values", () => {
  assert.equal(decodeSocialConfigValue("big_commit_usd", "2500"), "2500");
  assert.equal(decodeSocialConfigValue("big_commit_usd", 2500), null);
  assert.deepEqual(decodeSocialConfigValue("holder_milestones", [500, 100]), [100, 500]);
  assert.equal(decodeSocialConfigValue("reactions", []), null);

  assert.deepEqual(socialConfigFromRows([]), SOCIAL_CONFIG_DEFAULTS);
  const config = socialConfigFromRows([
    { key: "big_commit_usd", value: "2500" },
    { key: "reactions", value: ["fire"] },
    { key: "why_boost_ms", value: "not a number" },
    { key: "retired_key", value: 1 },
  ]);
  assert.equal(config.big_commit_usd, "2500");
  assert.deepEqual(config.reactions, ["fire"]);
  assert.equal(config.why_boost_ms, SOCIAL_CONFIG_DEFAULTS.why_boost_ms);
  assert.equal("retired_key" in config, false);
  assert.ok(Object.isFrozen(config));
});

test("T-003-AC-2 blocked terms: stored lowercase, matched case-insensitively anywhere", () => {
  assert.equal(normalizeBlockedTerm("  MOON "), "moon");
  assert.equal(normalizeBlockedTerm("rug pull"), "rug pull");
  assert.equal(normalizeBlockedTerm("   "), null);
  assert.equal(normalizeBlockedTerm("x".repeat(201)), null);
  assert.equal(normalizeBlockedTerm("bad\nterm"), null);

  assert.equal(matchBlockedTerm(["moon"], "to the MOON"), "moon");
  assert.equal(matchBlockedTerm(["moon"], "Moonshot"), "moon");
  assert.equal(matchBlockedTerm(["moon"], "to the sun"), null);
  assert.equal(matchBlockedTerm(["rug pull"], "Classic RUG PULL here"), "rug pull");
  assert.equal(matchBlockedTerm([], "anything"), null);
});

test("the cache keeps a value for 30 s from its load's start and shares a load in flight", async () => {
  let clock = 0;
  let loads = 0;
  let release: (() => void) | null = null;
  const load = cachedLoader(
    async () => {
      loads += 1;
      const started = loads;
      if (started === 1) await new Promise<void>((resolve) => (release = resolve));
      return started;
    },
    { now: () => clock },
  );
  const first = load();
  const second = load();
  clock = 1_000;
  release!();
  assert.deepEqual(await Promise.all([first, second]), [1, 1]);
  assert.equal(loads, 1);
  clock = SOCIAL_CONFIG_CACHE_MS - 1;
  assert.equal(await load(), 1);
  clock = SOCIAL_CONFIG_CACHE_MS;
  assert.equal(await load(), 2);
});

test("a failed load is not cached", async () => {
  let fail = true;
  const load = cachedLoader(async () => {
    if (fail) throw new Error("database unavailable");
    return "ok";
  }, { now: () => 0 });
  await assert.rejects(load(), /database unavailable/);
  fail = false;
  assert.equal(await load(), "ok");
});

class MemoryConfigDatabase implements ReadableDatabase {
  config = new Map<string, unknown>();
  terms = new Set<string>();
  reads = 0;

  async read<Row extends QueryResultRow>(text: string): Promise<QueryResult<Row>> {
    this.reads += 1;
    const rows = text.includes("social_config")
      ? [...this.config].map(([key, value]) => ({ key, value }))
      : [...this.terms].sort().map((term) => ({ term }));
    return { rows: rows as unknown as Row[], rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
  }
}

test("T-003-AC-1/AC-2 a warm reader sees a change within 60 s", async () => {
  let clock = 0;
  const db = new MemoryConfigDatabase();
  const reader = createSocialConfigReader(db, { now: () => clock });

  assert.equal((await reader.getSocialConfig()).big_commit_usd, "1000");
  assert.equal(await reader.findBlockedTerm("to the MOON"), null);
  db.config.set("big_commit_usd", "2500");
  db.terms.add("moon");

  clock = 10_000;
  assert.equal((await reader.getSocialConfig()).big_commit_usd, "1000", "served from the warm cache");
  assert.equal(await reader.findBlockedTerm("to the MOON"), null);
  assert.equal(db.reads, 2);

  clock = 59_999;
  assert.equal((await reader.getSocialConfig()).big_commit_usd, "2500");
  assert.equal(await reader.findBlockedTerm("to the MOON"), "moon");

  db.terms.delete("moon");
  clock += SOCIAL_CONFIG_CACHE_MS;
  assert.equal(await reader.findBlockedTerm("to the MOON"), null);
});
