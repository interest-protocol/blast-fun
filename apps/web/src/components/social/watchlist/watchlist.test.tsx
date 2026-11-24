import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { SocialPresaleSummary } from "@blast/core/modules/social/contracts/presales.ts";

import type { ApiResult } from "#web/components/social/social-api.ts";
import { WatchlistCardView } from "./WatchlistCard";
import { fetchWatchlistKeys } from "./watchlist-client.ts";
import { rowOfProfilePresale, rowOfSummary, watchedCoin, watchedCoinIds, watchlistLine, type WatchlistRow } from "./watchlist-model";
import { WatchlistStore, type WatchlistCalls } from "./watchlist-store";

const NOW = Date.UTC(2026, 9, 3, 18);
const HOUR = 3_600_000;
const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

function summary(n: number, over: Partial<SocialPresaleSummary> = {}): SocialPresaleSummary {
  return {
    presale_id: id(n), name: `Sale ${n}`, symbol: `S${n}`, icon_url: "", phase: "open", venue: "cetus",
    start_ms: NOW - HOUR, end_ms: NOW + 6 * HOUR + 12 * 60_000 + 41_000, ended_ms: null, launched_ms: null,
    target_usd: "250000.00", raised_usd: "184221.00", quote_type: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", quote_symbol: "USDC", quote_decimals: 6, target_atoms: "250000000000",
    raised_atoms: "184221000000", fill_bps: 7368, participants: 1012, interested: 3,
    presale_price_usd: null, presale_price_quote: null, price_usd: null, multiple: null, verified_team: false, audited: false, metadata: null, ...over,
  };
}

/** Scripted calls: keys (the stars, newest first), a page (the stars, then `followed` not starred) and writes answered in order (`writes` default ok). */
function scripted(ids: string[], writes: ApiResult<null>[] = [], followed: string[] = []) {
  const log: string[] = [];
  let release: (() => void) | null = null;
  const calls: WatchlistCalls = {
    keys: async () => {
      log.push("keys");
      if (release === null) await new Promise<void>((resolve) => { release = resolve; });
      return { status: "ok", body: { keys: ids }, httpStatus: 200 };
    },
    page: async () => {
      log.push("page");
      const entries = [...ids.filter((key) => !key.includes("::")).map((presale) => ({ presale, starred: true })), ...followed.filter((presale) => !ids.includes(presale)).map((presale) => ({ presale, starred: false }))];
      const items = entries.map(({ presale, starred }) => ({ presale: summary(Number.parseInt(presale.slice(2), 16)), added_ms: 1, starred, followed: followed.includes(presale) }));
      return { status: "ok", body: { items, total: items.length, next_cursor: null, as_of: { checkpoint: 1, timestamp_ms: 1, lag_ms: 0 } }, httpStatus: 200 };
    },
    set: async (_options, presaleId, on) => {
      log.push(`${on ? "PUT" : "DELETE"} ${presaleId}`);
      return writes.shift() ?? { status: "ok", body: null, httpStatus: 204 };
    },
  };
  return {
    calls,
    log,
    release: () => (release ? release() : (release = () => undefined)),
    /** What the server holds now (the next page read answers it). */
    server: { stars: ids, followed },
  };
}

const options = { getAccessToken: async () => "token" };

test("the watchlist keys client keeps sales and curve coins in saved order and rejects duplicates", async () => {
  const body = { keys: [id(2), `${id(3)}::curve::CURVE`, id(1)] };
  const read = (value: unknown) => fetchWatchlistKeys({
    ...options,
    fetch: async () => Response.json(value, { headers: { "X-Request-ID": "watchlist-ref" } }),
  });

  assert.deepEqual(await read(body), { status: "ok", body, httpStatus: 200 });
  assert.deepEqual(await read({ keys: [id(1), id(1)] }), {
    status: "error",
    code: "invalid_response",
    httpStatus: 200,
    requestId: "watchlist-ref",
  });
});

test("UI-12 (OA-11): the store reads the ids once; a star shows at once and is written; a toggle crossing the read wins", async () => {
  const { calls, log, release } = scripted([id(1)]);
  const store = new WatchlistStore(options, calls);
  const reading = store.loadIds();
  void store.loadIds();
  assert.equal(store.getSnapshot().status, "loading");
  // Unstar 1 and star 2 while the read is in flight.
  const off = store.toggle({ presale_id: id(1) }, false);
  const on = store.toggle(summary(2), true);
  assert.equal(store.has(id(2)), true);
  release();
  await reading;
  assert.deepEqual([await off, await on], ["off", "on"]);
  assert.deepEqual([...store.getSnapshot().ids], [id(2)]);
  assert.equal(store.getSnapshot().status, "ready");
  assert.deepEqual(log, ["keys", `DELETE ${id(1)}`, `PUT ${id(2)}`]);
});

test("UI-12: a refused star goes back; a full watchlist says so; the card's rows follow a change", async () => {
  const { calls, release } = scripted([id(1), id(3)], [{ status: "error" }, { status: "ok", body: null, httpStatus: 204 }, { status: "refused", code: "watchlist_limit", retryAfterSeconds: null }]);
  release();
  const store = new WatchlistStore(options, calls);
  await store.loadIds();
  await store.loadRows();
  assert.deepEqual(store.getSnapshot().rows?.items.map((item) => item.presale.presale_id), [id(1), id(3)]);
  let notified = 0;
  store.subscribe(() => (notified += 1));
  // A failed unstar: the row and the star come back.
  const failing = store.toggle({ presale_id: id(1) }, false);
  assert.deepEqual(store.getSnapshot().rows?.items.map((item) => item.presale.presale_id), [id(3)]);
  assert.equal(store.getSnapshot().rows?.total, 1);
  // A save made while the unstar is in flight stays first.
  const saving = store.toggle(summary(2), true);
  assert.equal(await failing, "failed");
  assert.equal(await saving, "on");
  assert.deepEqual([...store.getSnapshot().ids], [id(2), id(1), id(3)]);
  assert.equal(store.getSnapshot().rows?.total, 2);
  // A star past the limit: "limit", not starred.
  assert.equal(await store.toggle(summary(4), true), "limit");
  assert.equal(store.has(id(4)), false);
  assert.ok(notified >= 4);
  // A good star leads the card at once.
  const starring = store.toggle(summary(5), true);
  assert.equal(store.getSnapshot().rows?.items[0]?.presale.presale_id, id(5));
  assert.equal(await starring, "on");
});

test("UI-12b (OA-17): the card lists stars then follows; unstarring a followed row keeps it, starring one moves it up", async () => {
  const { calls, release, server } = scripted([id(1)], [], [id(1), id(2)]);
  release();
  const store = new WatchlistStore(options, calls);
  await store.loadIds();
  await store.loadRows();
  const shown = () => store.getSnapshot().rows?.items.map((item) => [item.presale.presale_id, item.starred, item.followed]);
  assert.deepEqual(shown(), [[id(1), true, true], [id(2), false, true]]);
  assert.equal(store.getSnapshot().rows?.total, 2);
  // Unstar 1: still followed, so it stays (counted once) until the read moves it among the follows.
  server.stars.splice(0);
  const off = store.toggle({ presale_id: id(1) }, false);
  assert.deepEqual(shown(), [[id(1), false, true], [id(2), false, true]]);
  assert.equal(store.getSnapshot().rows?.total, 2);
  assert.equal(await off, "off");
  // Star 2 (a follow): it leads at once and is not counted twice.
  server.stars.push(id(2));
  const on = store.toggle(summary(2), true);
  assert.deepEqual(shown()?.[0], [id(2), true, true]);
  assert.equal(store.getSnapshot().rows?.total, 2);
  assert.equal(await on, "on");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(shown(), [[id(2), true, true], [id(1), false, true]]);
});

test("a saved curve coin joins the ids at once but never the card's sale rows", async () => {
  const curve = `${id(3)}::curve::CURVE`;
  const { calls, release } = scripted([id(1)]);
  release();
  const store = new WatchlistStore(options, calls);
  await store.loadIds();
  await store.loadRows();
  const pending = store.toggle({ presale_id: curve }, true);
  // The newest save leads, so Home's first 50 always hold it.
  assert.deepEqual([...store.getSnapshot().ids], [curve, id(1)]);
  assert.deepEqual(store.getSnapshot().rows?.items.map((item) => item.presale.presale_id), [id(1)]);
  assert.equal(store.getSnapshot().rows?.total, 1);
  assert.equal(await pending, "on");
});

test("UI-12b (OA-17): a presale follow written on the page reaches the card live", async () => {
  const { calls, release, server, log } = scripted([id(1)], [], [id(2)]);
  release();
  const store = new WatchlistStore(options, calls);
  await store.loadIds();
  // Before the card asks for rows, a follow changes nothing and reads nothing.
  store.followChanged(id(3), true);
  assert.equal(store.getSnapshot().rows, null);
  await store.loadRows();
  const shown = () => store.getSnapshot().rows?.items.map((item) => item.presale.presale_id);
  // Unfollow 2 (not starred): it goes at once.
  server.followed.splice(0);
  store.followChanged(id(2), false);
  assert.deepEqual(shown(), [id(1)]);
  assert.equal(store.getSnapshot().rows?.total, 1);
  // Follow 3: it comes with the read that follows the write.
  server.followed.push(id(3));
  store.followChanged(id(3), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(shown(), [id(1), id(3)]);
  assert.equal(store.getSnapshot().rows?.total, 2);
  // Unfollow a starred row: it stays, no longer followed.
  server.followed.push(id(1));
  await store.loadRows();
  server.followed.splice(0, 2);
  store.followChanged(id(1), false);
  assert.deepEqual(store.getSnapshot().rows?.items[0] && [store.getSnapshot().rows!.items[0]!.presale.presale_id, store.getSnapshot().rows!.items[0]!.followed], [id(1), false]);
  assert.ok(log.filter((entry) => entry === "page").length >= 4);
});

test("UI-12 (§5.5): the watchlist lines and the card", () => {
  const open = rowOfSummary(summary(1, { name: "Meridian" }));
  assert.equal(watchlistLine(open, NOW), "73% filled · 6h 12m left");
  const pending = rowOfSummary(summary(2, { name: "Sable", phase: "pending", start_ms: Date.UTC(2026, 9, 14, 18) }));
  assert.equal(watchlistLine(pending, NOW), "Opens Oct 14, 18:00 UTC");
  assert.equal(watchlistLine(rowOfSummary(summary(3, { phase: "trading", multiple: "4.2" })), NOW), "4.2× since presale");
  assert.equal(watchlistLine(rowOfSummary(summary(3, { phase: "trading", multiple: null })), NOW), "Trading");
  assert.equal(watchlistLine(rowOfSummary(summary(4, { phase: "funded" })), NOW), "Funded");
  assert.equal(watchlistLine(rowOfProfilePresale({ presale_id: id(5), symbol: "C", name: "Cobalt", icon_url: "", status: "cancelled", venue: "cetus", start_ms: 0, end_ms: 0, fill_pct: 20, quote_symbol: "USDC", quote_decimals: 6, launched_ms: null, first_unlock_ms: null }), NOW), "Cancelled");

  const rows: WatchlistRow[] = [open, pending, rowOfSummary(summary(4, { name: "Cobalt", phase: "funded" }))];
  const html = renderToStaticMarkup(<WatchlistCardView items={rows} nowMs={NOW} status="ready" total={3} />);
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  assert.match(text, /Watchlist 3 Meridian 73% filled · 6h 12m left Sable Opens 14 Oct ’26 Cobalt Funded/);
  assert.match(html, /aria-label="Notify me for Sable"/);
  assert.equal((html.match(/href="\/presale\//g) ?? []).length, 3);
  // Empty and visitor states keep the short status, without a count. Errors retain retry.
  assert.match(renderToStaticMarkup(<WatchlistCardView items={[]} nowMs={NOW} status="visitor" total={0} />), /<span>Watchlist<\/span><\/h3><div class="[^"]*compactEmpty[^"]*"><p[^>]*>No saved presales<\/p>/);
  assert.doesNotMatch(renderToStaticMarkup(<WatchlistCardView items={[]} nowMs={NOW} status="loading" total={0} />), /No saved presales/);
  assert.match(renderToStaticMarkup(<WatchlistCardView items={[]} nowMs={NOW} status="error" total={0} />), /couldn’t load.*Try again/);
});

test("the boards' watchlist: a presale now trading is a coin row (ticker, price, 24h change), listed first", () => {
  const coin = rowOfSummary(summary(6, { name: "Hippo", symbol: "HIPPO", phase: "trading", price_usd: "0.00000812", multiple: "4.2" }));
  const falling = rowOfSummary(summary(7, { name: "Navi", symbol: "NAVX", phase: "trading", price_usd: "0.0412", multiple: "0.8" }));
  const open = rowOfSummary(summary(1, { name: "Meridian" }));
  const pending = rowOfSummary(summary(2, { name: "Sable", phase: "pending", start_ms: Date.UTC(2026, 9, 14, 18) }));
  const unpriced = rowOfSummary(summary(8, { name: "Quiet", phase: "trading", price_usd: null, multiple: null }));
  const changes = new Map([[id(6), 1820], [id(7), -305]]);
  const html = renderToStaticMarkup(<WatchlistCardView changes={changes} items={[pending, open, unpriced, coin, falling]} nowMs={NOW} status="ready" total={5} />);
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  assert.match(text, /Watchlist 5 HIPPO \$0\.0₅812 \+18\.2% NAVX \$0\.0412 −3\.05% Meridian 73% filled · 6h 12m left Sable Opens 14 Oct ’26 Quiet Trading/);
  assert.match(html, /<span class="up">\+18\.2%<\/span>/);
  assert.match(html, /<span class="down">−3\.05%<\/span>/);
  assert.match(html, /aria-label="HIPPO, \$0\.0₅812, \+18\.2% today"/);
  assert.doesNotMatch(text, /×/, "the multiple since the presale is not drawn under a coin's price");
  assert.match(html, /aria-label="Notify me for Sable"[^>]*data-ui-size="xs"/);
  // Only the coin rows' changes are read.
  assert.deepEqual(watchedCoinIds([pending, open, unpriced, coin, falling]), [id(6), id(7)]);
});

test("a coin row's 24h change: up, down, none (left out, never the multiple or a dash) and still reading", () => {
  const coin = rowOfSummary(summary(6, { symbol: "CETUS", phase: "trading", price_usd: "0.0951", multiple: "4.2" }));
  assert.deepEqual(watchedCoin(coin, 571)?.move, { text: "+5.71%", tone: "up" });
  assert.deepEqual(watchedCoin(coin, -305)?.move, { text: "−3.05%", tone: "down" });
  assert.deepEqual(watchedCoin(coin, 0)?.move, { text: "+0%", tone: "up" });
  assert.equal(watchedCoin(coin, null)?.move, null);
  assert.equal(watchedCoin(coin, null)?.label, "CETUS, $0.0951");
  assert.equal(watchedCoin(coin, undefined)?.move, "loading");
  const shown = (changes?: ReadonlyMap<string, number | null>) => renderToStaticMarkup(<WatchlistCardView changes={changes} items={[coin]} nowMs={NOW} status="ready" total={1} />);
  // No change: the price alone.
  assert.match(shown(new Map([[id(6), null]])), /<span class="v"><b>\$0\.0951<\/b><\/span>/);
  // Still reading: a skeleton in the change's place, out of the accessible name.
  const reading = shown(new Map());
  assert.match(reading, /<span class="v"><b>\$0\.0951<\/b><span aria-hidden="true" class="text">\+0\.00%<\/span><\/span>/);
  assert.match(reading, /aria-label="CETUS, \$0\.0951"/);
});
