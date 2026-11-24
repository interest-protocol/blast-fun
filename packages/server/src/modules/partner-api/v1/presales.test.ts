import assert from "node:assert/strict";
import test from "node:test";

import { projectedResponse, v1PresaleDetail, v1PresaleSummaries } from "./presales.ts";

const summary = { presale_id: "0x1", name: "Orbit", phase: "open", backers_sample: [{ callsign: "maya" }] };

test("v1 summaries drop the facepile and the page its tab counts, keeping every published field, on list pages and featured", () => {
  const page = { presales: [summary, { presale_id: "0x2", name: "Vela" }], next_cursor: "c", status_counts: { live: 1, upcoming: 0, ended: 3 }, as_of: { checkpoint: 1 } };
  assert.deepEqual(v1PresaleSummaries(page), {
    presales: [{ presale_id: "0x1", name: "Orbit", phase: "open" }, { presale_id: "0x2", name: "Vela" }],
    next_cursor: "c",
    as_of: { checkpoint: 1 },
  });
  assert.deepEqual(v1PresaleSummaries({ presales: [summary] }), { presales: [{ presale_id: "0x1", name: "Orbit", phase: "open" }] });
  assert.deepEqual(v1PresaleSummaries({ error: "x" }), { error: "x" }, "not a page: unchanged");
});

test("the v1 detail drops web-only terms and leaves published terms", () => {
  const terms = { hard_cap: "100", launch_price_quote: "0.1", launch_fdv_quote: "1000", trading_fee_ppm: 2500, public_buy: { from_ms: 96, min_atoms: "1", hard_cap_from_ms: 0 }, eligible_uncapped_from_ms: 90 };
  const detail = { presale: { ...summary }, terms, theses: [] };
  assert.deepEqual(v1PresaleDetail(detail), { presale: { ...summary }, terms: { hard_cap: "100", launch_price_quote: "0.1" }, theses: [] });
  assert.deepEqual(v1PresaleDetail({ presale: {}, terms: null }), { presale: {}, terms: null }, "no terms: unchanged");
});

test("every sale's cover drops its upload size in v1, on summaries and the detail", () => {
  const cover = { url: "https://cdn.blast.fun/c.png", width: 1200, height: 630, source: { width: 4000, height: 2100 } };
  const published = { url: "https://cdn.blast.fun/c.png", width: 1200, height: 630 };
  const sale = { presale_id: "0x1", metadata: { description: "d", cover } };
  assert.deepEqual(v1PresaleSummaries({ presales: [{ ...sale, backers_sample: [] }] }), {
    presales: [{ presale_id: "0x1", metadata: { description: "d", cover: published } }],
  });
  assert.deepEqual(v1PresaleDetail({ presale: sale, terms: null }), {
    presale: { presale_id: "0x1", metadata: { description: "d", cover: published } },
    terms: null,
  });
  const uncovered = { presale_id: "0x2", metadata: { description: "d", cover: null } };
  assert.deepEqual(v1PresaleSummaries({ presales: [uncovered] }), { presales: [uncovered] }, "no cover: unchanged");
});

test("only a JSON 200 is projected; its status and headers stay, its length is recomputed", async () => {
  const ok = new Response(JSON.stringify({ presales: [summary] }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "content-length": "999", etag: "\"v\"" },
  });
  const projected = await projectedResponse(ok, v1PresaleSummaries);
  assert.equal(projected.status, 200);
  assert.equal(projected.headers.get("content-length"), null);
  assert.equal(projected.headers.get("etag"), "\"v\"");
  assert.deepEqual(await projected.json(), { presales: [{ presale_id: "0x1", name: "Orbit", phase: "open" }] });
  for (const passed of [
    new Response(JSON.stringify({ error: { code: "rate_limited" } }), { status: 429, headers: { "content-type": "application/json" } }),
    new Response(null, { status: 304 }),
    new Response("plain", { status: 200, headers: { "content-type": "text/plain" } }),
  ]) assert.equal(await projectedResponse(passed, v1PresaleSummaries), passed);
});


test("canonical frontend coin identity stays outside the pinned partner v1 contract", () => {
  const sale = { presale_id: "0x1", name: "Orbit", coin_type: "0x2::orbit::ORBIT" };
  const published = { presale_id: "0x1", name: "Orbit" };
  assert.deepEqual(v1PresaleSummaries({ presales: [sale] }), { presales: [published] });
  assert.deepEqual(v1PresaleDetail({ presale: sale, terms: null }), { presale: published, terms: null });
  assert.deepEqual(v1PresaleDetail({ presale: sale, terms: null, activity: [{ presale: sale }, { presale: null }, { kind: "notice" }] }), {
    presale: published, terms: null, activity: [{ presale: published }, { presale: null }, { kind: "notice" }],
  });
  assert.equal(sale.coin_type, "0x2::orbit::ORBIT", "first-party source data is preserved");
  // R3-23: v1 publishes the sale's verified_team but not an activity row's.
  const verified = { ...sale, verified_team: true };
  assert.deepEqual(v1PresaleDetail({ presale: verified, terms: null, activity: [{ presale: verified }] }), {
    presale: { ...published, verified_team: true }, terms: null, activity: [{ presale: published }],
  });
});
