import assert from "node:assert/strict";
import test from "node:test";
import { fixtureList, FIXTURE_NOW } from "../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts";
import { eligibleFeatured, featuredVisible, shuffleFeatured } from "./featured-model";

const live = fixtureList("live", "ending").presales;
const pending = fixtureList("upcoming", "opening").presales;

test("featured eligibility keeps open and upcoming sales, ignoring duplicates and expired or ended sales, without truncating", () => {
  const ordered = [live[1], pending[0], live[0], live[1], ...pending, ...fixtureList("ended", "recent").presales];
  assert.deepEqual(eligibleFeatured(ordered, FIXTURE_NOW), [live[1], pending[0], live[0], ...pending.slice(1)]);
  assert.deepEqual(eligibleFeatured([{ ...live[0], end_ms: FIXTURE_NOW }], FIXTURE_NOW), []);
  const many = Array.from({ length: 8 }, (_, i) => ({ ...live[0], presale_id: `sale-${i}` }));
  assert.deepEqual(eligibleFeatured(many, FIXTURE_NOW), many);
  assert.deepEqual(eligibleFeatured([], FIXTURE_NOW), []);
});

test("the featured card shows on the list view only, whatever the tab", () => {
  assert.equal(featuredVisible("list"), true);
  assert.equal(featuredVisible("calendar"), false);
  assert.equal(featuredVisible("backed"), false);
});

test("three pins can appear in all six orders and stay ordered when the source list changes", () => {
  const pins = [live[0]!, live[1]!, pending[0]!];
  const orders = new Set(Array.from({ length: 32 }, (_, seed) => (
    shuffleFeatured(pins, String(seed)).map(sale => sale.presale_id).join(",")
  )));
  assert.equal(orders.size, 6);
  const shuffled = shuffleFeatured(pins, "page-b");
  assert.deepEqual(shuffleFeatured([...pins].reverse(), "page-b"), shuffled);
  assert.deepEqual(shuffleFeatured(pins.slice(1), "page-b"), shuffled.filter(sale => sale !== pins[0]));
});
