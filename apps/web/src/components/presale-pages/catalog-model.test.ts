import assert from "node:assert/strict";
import test from "node:test";
import { catalogTags, catalogFunding, catalogTime, catalogStatus, searchPresales } from "./catalog-model.ts";
import { fixtureList, FIXTURE_NOW } from "../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts";

const base = fixtureList("live", "ending").presales[0]!;
const sale = { ...base, quote_symbol: "TSUI", quote_decimals: 9, target_atoms: "250000000000000", fill_bps: 0 };
test("funding uses quote atoms, reveals overflow and caps only the bar", () => {
  for (const [raised_atoms, percentage, progress] of [["0", "0%", 0], ["125000000000000", "50%", 50], [sale.target_atoms, "100%", 100], ["250012500000000", "100.005%", 100]] as const) {
    const result = catalogFunding({ ...sale, raised_atoms });
    assert.equal(result.percentage, percentage);
    assert.equal(result.progress, progress);
    assert.equal(result.over, BigInt(raised_atoms) > BigInt(sale.target_atoms));
  }
  const over = catalogFunding({ ...sale, raised_atoms: "250012500000000" });
  assert.equal(over.committed, "250,012.5 TSUI");
  assert.equal(over.target, "250,000 TSUI");
  const atomOver = catalogFunding({ ...sale, raised_atoms: "250000000000001" });
  assert.equal(atomOver.committed, "250,000.000000001 TSUI");
  assert.equal(atomOver.percentage, ">100%");
  assert.equal(catalogFunding({ ...sale, raised_atoms: "1" }).committed, "<0.000001 TSUI");
  assert.equal(catalogFunding({ ...sale, target_atoms: "0", raised_atoms: "1" }).percentage, null, "no target: the percentage is left out, never a dash");
});
test("catalog time has explicit minute precision and lifecycle boundaries", () => {
  assert.equal(catalogTime({ ...base, end_ms: FIXTURE_NOW + (4 * 60 + 22) * 60000 }, FIXTURE_NOW), "Ends in 4h 22m");
  assert.equal(catalogTime({ ...base, end_ms: FIXTURE_NOW + 26 * 3600000 }, FIXTURE_NOW), "Ends in 1d 2h");
  assert.equal(catalogTime({ ...base, phase: "pending", start_ms: FIXTURE_NOW + 10 * 3600000 }, FIXTURE_NOW), "Starts in 10h 0m");
  assert.equal(catalogTime({ ...base, end_ms: FIXTURE_NOW }, FIXTURE_NOW), "Ended");
  assert.equal(catalogStatus({ ...base, end_ms: FIXTURE_NOW }, FIXTURE_NOW), "ended");
  assert.equal(catalogTime({ ...base, phase: "pending", start_ms: 0 }, FIXTURE_NOW), "Start time to be announced");
  assert.equal(catalogTime({ ...base, phase: "pending", start_ms: FIXTURE_NOW }, FIXTURE_NOW), "Awaiting opening");
});
test("search matches project name, ticker and presale address without matching an unrelated project", () => {
  for (const search of [base.name.toUpperCase(), ` ${base.symbol.toLowerCase()} `, base.presale_id]) assert.deepEqual(searchPresales([base], search), [base]);
  assert.deepEqual(searchPresales([base], "missing project"), []);
});

test("ordinary ratios stay concise and near-target amounts remain distinguishable", () => {
  assert.equal(catalogFunding({ ...sale, raised_atoms: "184221000000000" }).percentage, "73.68%");
  const below = catalogFunding({ ...sale, raised_atoms: "250000000000000", target_atoms: "250000005000000" });
  assert.equal(below.target, "250,000.005 TSUI");
  assert.equal(below.over, false);
  assert.notEqual(below.committed, below.target);
});

test("badges distinguish configured terms from observed funding and omit unknowns", () => {
  const empty = { ...sale, raised_atoms: "0", audited: false, verified_team: false };
  assert.deepEqual(catalogTags(empty), []);
  assert.deepEqual(catalogTags({ ...empty, allowlisted: true, hard_cap: false }), ["Allowlist"]);
  assert.deepEqual(catalogTags({ ...empty, allowlisted: false, hard_cap: true }), []);
  assert.deepEqual(catalogTags({ ...empty, hard_cap: true, target_atoms: "250000005000000" }), []);
  assert.deepEqual(catalogTags({ ...empty, raised_atoms: "250000000000001", hard_cap: false }), ["Above target"]);
});
