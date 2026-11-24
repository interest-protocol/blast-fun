import assert from "node:assert/strict";
import test from "node:test";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { readFeaturedPresales } from "@blast/server/modules/social/presales/route.ts";
import type { SummaryRow } from "@blast/server/modules/social/presales/summary.ts";
import { BACKER_SAMPLE_SQL } from "@blast/server/modules/social/presales/backer-sample.ts";
import { PRESALE_BACKER_SAMPLE_COMMITS } from "@blast/core/modules/social/contracts/presales.ts";

const id = (letter: string) => `0x${letter.repeat(64)}`;
const base: SummaryRow = {
  presale_id: id("a"), name: "Editorial project", symbol: "EDIT", icon_url: "", lifecycle: "open", start_ms: "100", end_ms: "200",
  venue: "cetus", participants: "3", sale_token: `${id("a")}::edit::EDIT`, sale_decimals: 9, quote_type: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI", quote_symbol: "SUI", raise_target: "10000000000", total_commitments: "2500000000",
  quote_decimals: 9, stable: false, target_usd: "10.00", raised_usd: "2.50", allowlisted: false, min_commitment_usd: null, wallet_cap_usd: null,
  min_commitment_atoms: null, wallet_cap_atoms: null, opened_ms: null, funded_ms: null, migrated_ms: null, cancelled_ms: null, interested: 0,
  claimed_price_usd: null, claimed_price_quote: null, price_usd: null, verified_team: false, audited: false, sort_key: null,
  tagline: null, site: null, x_handle: null, telegram: null, docs_url: null, audit_url: null, launch_at_ms: null,
  cover_key: null, cover_url: null, cover_width: null, cover_height: null, cover_source_width: null, cover_source_height: null,
};
const person = (callsign: string, last_ms: string) => ({
  presale_id: id("a"), last_ms, person_callsign: callsign, person_display_name: null, person_avatar_url: `https://img.example/${callsign}.png`, person_verified: false,
});

test("admin pins resolve in newest-pin order through canonical summaries, ignoring hidden and ineligible sales", async () => {
  const calls: { sql: string; values?: readonly unknown[] }[] = [];
  const db: ReadableDatabase = {
    read: async (sql, values) => {
      calls.push({ sql, values });
      return { rows: sql.includes("chain_read_v1.watermark") ? [{ market_checkpoint: "1", presale_checkpoint: "1", market_timestamp_ms: "150", presale_timestamp_ms: "150", observed_ms: "150" }]
        : sql.includes("FROM social_presale_pins") ? ["b", "f", "a", "c", "d"].map((letter) => ({ presale_id: id(letter) }))
        // Gap 11: four named backers among sale a's latest commits; the facepile keeps the latest three.
        : sql === BACKER_SAMPLE_SQL ? [person("kenji", "120"), person("ana", "140"), person("bo", "100"), person("cy", "130")] : [
          base, { ...base, presale_id: id("b"), lifecycle: "pending" }, { ...base, presale_id: id("c"), lifecycle: "cancelled" }, { ...base, presale_id: id("d"), end_ms: "150" },
        ] } as never;
    },
  };
  const result = await readFeaturedPresales(db, 150);
  assert.deepEqual(result.map((sale) => sale.presale_id), [id("b"), id("a")]);
  assert.equal(calls.length, 4, "watermark, pins, one summary batch and one facepile batch; no per-card reads");
  assert.match(calls[1].sql, /ORDER BY pinned_at DESC, presale_id COLLATE "C" DESC/);
  assert.deepEqual(calls[2].values?.[1], [id("b"), id("f"), id("a"), id("c"), id("d")]);
  assert.equal(result[1].fill_bps, 2500);
  assert.equal(result[1].quote_symbol, "SUI");
  assert.equal(result[1].participants, 3);
  assert.deepEqual(calls[3].values, [[id("b"), id("a")], PRESALE_BACKER_SAMPLE_COMMITS], "the facepile reads the shown sales' latest commits only");
  assert.deepEqual(result[1].backers_sample?.map((backer) => backer.callsign), ["ana", "cy", "kenji"]);
  assert.deepEqual(result[0].backers_sample, [], "no named backer: no faces, the count alone");
});

test("no admin pins returns no featured sales and never invents a selection", async () => {
  const db: ReadableDatabase = {
    read: async (sql) => ({ rows: sql.includes("chain_read_v1.watermark")
      ? [{ market_checkpoint: "1", presale_checkpoint: "1", market_timestamp_ms: "150", presale_timestamp_ms: "150", observed_ms: "150" }]
      : [] }) as never,
  };
  assert.deepEqual(await readFeaturedPresales(db, 150), []);
});
