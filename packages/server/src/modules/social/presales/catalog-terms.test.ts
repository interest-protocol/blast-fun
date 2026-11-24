import assert from "node:assert/strict";
import test from "node:test";
import type { PresaleTerms } from "@blast/core/modules/presale/terms/index.ts";
import { withCatalogTerms } from "@blast/server/modules/social/presales/catalog-terms.ts";
import { fixtureList } from "../../../../../core/test/fixtures/presale-pages/presale-fixtures.ts";
import { optionalSource } from "../optional-source.ts";

const share = { bps: 0, amount: "0" };
const terms: PresaleTerms = {
  presaleId: "fixture", raiseTarget: "100",
  supply: { total: "100", participants: share, liquidity: share, recipients: [], protocol: share },
  raise: { poolShare: "0", recipients: [], protocol: share },
  eligibility: { kind: "open" }, burnable: null, hardCap: false,
};

test("catalog terms retain order, bound concurrent reads, and leave failures unknown", async () => {
  const base = fixtureList("live", "ending").presales[0]!;
  const sales = Array.from({ length: 20 }, (_, i) => ({ ...base, presale_id: String(i), allowlisted: i === 0 }));
  let active = 0;
  let peak = 0;
  const result = await withCatalogTerms(sales, id => optionalSource("presale_terms", async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active--;
    if (id === "1") throw new Error("Unavailable");
    return id === "2" ? null : { ...terms, hardCap: id === "3" ? true : false };
  }, null));
  assert.ok(peak <= 8);
  assert.deepEqual(result.map(sale => sale.presale_id), sales.map(sale => sale.presale_id));
  assert.equal(result[0]!.allowlisted, true);
  assert.equal(result[0]!.hard_cap, false);
  assert.equal(result[1]!.hard_cap, null);
  assert.equal(result[2]!.hard_cap, null);
  assert.equal(result[3]!.hard_cap, true);
  assert.equal(sales[0]!.presale_id, "0");
});
