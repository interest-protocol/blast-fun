import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { ProfilePresale } from "@blast/core/modules/social/contracts/profile-page.ts";
import { CreatedPresalesList, ProfileTabs } from "./ProfileTabs";

const presale: ProfilePresale = {
  presale_id: `0x${"1".repeat(64)}`, name: "Creator coin", symbol: "COIN", icon_url: "", status: "open", venue: "bluefin",
  start_ms: 1, end_ms: 2, fill_pct: 12, quote_symbol: "TEST_SUI", quote_decimals: 9, launched_ms: null, first_unlock_ms: null,
};

test("created presales link to the sale and keep its chain state visible", () => {
  const html = renderToStaticMarkup(<CreatedPresalesList presales={{ status: "ready", value: [presale] }} />);
  assert.ok(html.includes(`/presale/${presale.presale_id}`));
  assert.match(html, /Creator coin/);
  assert.match(html, /12% filled/);
  assert.match(html, />Open</);
});

test("created presales have named loading, recovery and empty states", () => {
  assert.match(renderToStaticMarkup(<CreatedPresalesList presales={{ status: "loading" }} />), /Loading created presales/);
  assert.match(renderToStaticMarkup(<CreatedPresalesList onRetry={() => {}} presales={{ status: "error" }} />), /Try again/);
  assert.match(renderToStaticMarkup(<CreatedPresalesList presales={{ status: "ready", value: [] }} />), /Create a presale/);
});

test("the Created section appears only on the owner’s profile", () => {
  const props = { callsign: "creator", calls: { status: "loading" as const }, nowMs: 1 };
  const own = renderToStaticMarkup(<ProfileTabs {...props} own />);
  const other = renderToStaticMarkup(<ProfileTabs {...props} />);
  assert.match(own, />Created</);
  assert.doesNotMatch(other, />Created</);
  // TS-5: three choices at most. Backed carries each call's thesis, so no Calls tab repeats it.
  assert.deepEqual([...own.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((m) => m[1]), ["Created", "Backed", "Activity"]);
  assert.deepEqual([...other.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((m) => m[1]), ["Backed", "Activity"]);
  assert.doesNotMatch(own + other, /Thesis|Presale calls|>Calls</);
});

test("Backed rows carry the account's thesis on one line under the call, and none without a why", async () => {
  const { CallsList } = await import("./ProfileTabs");
  const call = (over: Record<string, unknown>) => ({
    presale: { ...presale, status: "trading" as const, symbol: "WAL" }, committed_usd: "100.00", committed_atoms: "100000000",
    entry_price_usd: "0.31", price_usd: "0.4127", multiple: "1.3313", value_usd: null, pnl_usd: null, last_commit_ms: 1, series: null, ...over,
  });
  const as_of = { indexed_through_ms: 1, lag_ms: 0, status: "ok" };
  const html = renderToStaticMarkup(<CallsList calls={{ status: "ready", value: { calls: [
    call({ why: "Walrus storage demand keeps climbing" }),
    call({ presale: { ...presale, presale_id: `0x${"2".repeat(64)}`, name: "Names", status: "trading" }, why: null }),
    call({ presale: { ...presale, presale_id: `0x${"3".repeat(64)}`, name: "Deep", status: "trading" }, why: "  " }),
  ], track_record: { presales_backed: 3, launched: 3, pnl_usd: null }, as_of } as never }} />);
  const whys = [...html.matchAll(/class="[^"]*\bwhy\b[^"]*"[^>]*>([^<]*)</g)].map(([, text]) => text);
  assert.deepEqual(whys, ["Walrus storage demand keeps climbing"]);
  // The call's entry and price now stay on the row's line, with the multiple since presale.
  assert.match(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "), /at \$0\.3100 · now \$0\.4127/);
  assert.match(html, /since presale/);
});
