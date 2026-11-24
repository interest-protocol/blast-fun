import assert from "node:assert/strict";
import test from "node:test";
import { FIXTURE_NOW, fixtureDetail } from "../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts";
import { fundingState, teamUnlockState } from "@blast/core/modules/presale/presentation.ts";

const base = fixtureDetail("mrdn");
const amount = (raised: string, target = "50000000000000") => ({
  ...base, presale: { ...base.presale, raised_atoms: raised, target_atoms: target, fill_bps: 10000 },
});

test("funding classification uses exact atoms, independently of the rounded fill", () => {
  for (const [raised, relationship, percentage, label] of [
    ["49999999999999", "below", "99.99%", "99.99% of target"],
    ["50000000000000", "reached", "100.00%", "Target reached"],
    ["50000000000001", "oversubscribed", ">100%", "Oversubscribed"],
    ["50030000000000", "oversubscribed", "100.06%", "Oversubscribed"],
    ["250000000000000", "oversubscribed", "500.00%", "Oversubscribed"],
  ]) {
    const state = fundingState(amount(raised), FIXTURE_NOW);
    assert.equal(state.relationship, relationship);
    assert.equal(state.percentage, percentage);
    assert.equal(state.label, label);
    assert.equal(state.participation, "Commitments open");
  }
  assert.equal(fundingState(amount("18446744073709551615", "18446744073709551614"), FIXTURE_NOW).relationship, "oversubscribed");
});

test("the model and lifecycle stay distinct; deadlines close stale open reads", () => {
  const sale = amount("50030000000000");
  for (const hard_cap of [true, null]) {
    const state = fundingState({ ...sale, terms: { ...sale.terms!, hard_cap } }, FIXTURE_NOW);
    assert.equal(state.oversubscription, false);
    assert.equal(state.participation, "Check commitment availability");
  }
  assert.equal(fundingState({ ...sale, terms: null }, FIXTURE_NOW).oversubscription, false);
  for (const phase of ["closed", "funded", "trading", "cancelled", "pending"] as const) {
    const state = fundingState({ ...sale, presale: { ...sale.presale, phase } }, FIXTURE_NOW);
    assert.equal(state.open, false);
    assert.notEqual(state.participation, "Commitments open");
  }
  assert.equal(fundingState(sale, sale.presale.end_ms).participation, "Closed");
  assert.equal(fundingState(amount("0", "0"), FIXTURE_NOW).relationship, "unknown");
});

test("team unlock states never substitute the aggregate schedule or failed reads for pending", () => {
  assert.equal(teamUnlockState(base).kind, "configured");
  const missing = { ...base, team_vesting: null, terms: { ...base.terms!, supply: { ...base.terms!.supply, recipients: base.terms!.supply.recipients.map((recipient) => ({ ...recipient, vesting: null })) } } };
  assert.equal(teamUnlockState({ ...base, team_vesting: null }).kind, "unavailable", "ambiguous existing schedules are not pending");
  assert.equal(teamUnlockState(missing).kind, "pending");
  assert.equal(teamUnlockState({ ...missing, terms: null }).kind, "unavailable");
  assert.equal(teamUnlockState(missing, "loading").kind, "loading");
  assert.equal(teamUnlockState(missing, "error").kind, "error");
  assert.equal(teamUnlockState({ ...missing, presale: { ...missing.presale, phase: "trading" } }).kind, "unavailable");
  assert.equal(teamUnlockState({ ...missing, terms: { ...base.terms!, supply: { ...base.terms!.supply, recipients: [] } } }).kind, "none");
  assert.equal(teamUnlockState({ ...missing, presale: { ...missing.presale, phase: "cancelled" } }).kind, "cancelled");
  const zeroLength = { start_ms: FIXTURE_NOW, cliff_end_ms: FIXTURE_NOW, end_ms: FIXTURE_NOW };
  assert.equal(teamUnlockState({ ...missing, team_vesting: zeroLength }).kind, "unavailable");
});
