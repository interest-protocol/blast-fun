import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { QueryResult, QueryResultRow } from "pg";

import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { SOCIAL_CONFIG_DEFAULTS, type SocialConfig } from "@blast/core/modules/social/contracts/config.ts";
import type { FeedItem } from "@blast/core/modules/social/contracts/items.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import type { FeedEntry } from "@blast/core/modules/social/read-model/entries.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import {
  buildItem,
  compareDecimal,
  decodeItemCursor,
  doTheSameDescriptor,
  encodeItemCursor,
  nextItemCursor,
  parseItemLimit,
  parseItemPage,
  readAsOf,
  shortAddress,
  toItems,
  toUsd,
  type ItemLookups,
} from "@blast/server/modules/social/items/index.ts";

/**
 * Social feed T-005 unit checks: decimals, the do-the-same rule, the cursor
 * codec and limit bounds, the pure item builder and the published schema. The
 * mapping against a database is items.integration.test.ts.
 */
const validator = createSocialValidator();
const PRESALE = `0x${"ab".repeat(32)}`;
const WALLET = `0x1a2b${"0".repeat(56)}9f0e`;
const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const NOW = 1_791_700_000_000;

function entry(extra: Partial<FeedEntry> = {}): FeedEntry {
  return {
    entryId: "a:5000:1:0:0",
    source: "activity",
    kind: "presale_commit",
    product: "presale",
    occurredAtMs: NOW - 60_000,
    actor: WALLET,
    presaleId: PRESALE,
    coinType: null,
    digest: "8Fq".padEnd(44, "1"),
    activityId: "5000:1:0:0",
    quoteType: "0x2::usdc::USDC",
    quoteAmount: "20000000000",
    coinAmount: null,
    quoteRefund: null,
    usdValue: "20000",
    usdPriceAsOfMs: NOW - 61_000,
    milestoneValue: null,
    namedAccountId: null,
    ...extra,
  };
}

type PresaleLookup = ItemLookups["presales"] extends ReadonlyMap<string, infer Row> ? Row : never;

/** A presale lookup row as PRESALES_SQL answers it: open, no allocation and no prices unless given. */
function presaleRow(extra: Partial<PresaleLookup> = {}): PresaleLookup {
  return {
    presale_id: PRESALE, coin_type: `${PRESALE}::coin::XYZ`, symbol: "XYZ", name: "Xyz", icon_url: "https://i/xyz.png", lifecycle: "open", decimals: 9,
    venue: "cetus", start_ms: String(NOW - 86_400_000), end_ms: String(NOW + 3_600_000), raise_target: "400000000000",
    raised: "399000000000", participants: "2216", quote_type: "0x2::usdc::USDC", quote_symbol: "USDC",
    quote_decimals: 6, presale_price_quote: null, quote_usd: null, quote_usd_as_of_ms: null, sale_usd: null,
    sale_usd_as_of_ms: null,
    ...extra,
  };
}

function lookups(extra: Partial<ItemLookups> = {}): ItemLookups {
  return {
    presales: new Map([[PRESALE, presaleRow()]]),
    identities: new Map([[ACCOUNT, {
      account_id: ACCOUNT, callsign: "kai", display_name: "Kai", avatar_url: "https://i/kai.png", x_handle: "kai", verified: true,
    }]]),
    whys: new Map(),
    reactions: new Map(),
    through: new Map(),
    backers: new Map(),
    ...extra,
  };
}

const CONTEXT = { nowMs: NOW, config: SOCIAL_CONFIG_DEFAULTS };

function build(extra: Partial<FeedEntry> = {}, config: SocialConfig = SOCIAL_CONFIG_DEFAULTS, map = lookups()): FeedItem | null {
  return buildItem(entry(extra), map, { nowMs: NOW, config });
}

function valid(item: unknown): void {
  assert.deepEqual(validator.validate("feed-item", item).errors, []);
}

test("decimals compare exactly and round to two places half away from zero", () => {
  assert.equal(compareDecimal("1000", "1000.000"), 0);
  assert.equal(compareDecimal("999.999999", "1000"), -1);
  assert.equal(compareDecimal("1000.0000001", "1000"), 1);
  assert.equal(compareDecimal("12345678901234567890.5", "12345678901234567890.49"), 1);
  for (const [value, usd] of [
    ["0", "0.00"], ["17.5", "17.50"], ["20000", "20000.00"], ["1234.565", "1234.57"], ["1234.5649", "1234.56"],
    ["0.004", "0.00"], ["0.005", "0.01"], ["99.995", "100.00"], ["-1.005", "-1.01"], ["-0.001", "0.00"],
  ] as const) {
    assert.equal(toUsd(value), usd, value);
  }
  assert.throws(() => toUsd("1e3"), /Not a decimal/);
  assert.throws(() => compareDecimal("", "1"), /Not a decimal/);
});

test("T-005-AC-5: the do-the-same descriptor follows the presale lifecycle, start and end time", () => {
  const commitToo = { kind: "commit", enabled: true, label: "Blast", href: null };
  const viewSale = { kind: "commit", enabled: false, label: "View presale", href: `/presale/${PRESALE}` };
  const presale = (lifecycle: string, endMs = NOW + 1, startMs = NOW - 1) => ({ presale_id: PRESALE, lifecycle, start_ms: startMs, end_ms: endMs });
  for (const kind of ["presale_commit", "presale_claim", "presale_opened", "presale_funded", "milestone_participants", "milestone_raise", "milestone_holders"]) {
    assert.deepEqual(doTheSameDescriptor(kind, presale("open"), NOW), commitToo, kind);
    assert.deepEqual(doTheSameDescriptor(kind, presale("open", NOW + 1, NOW), NOW), commitToo, `${kind} opening now`);
    // A sale shared with a scheduled start is `open` on chain, but `commit` refuses it until `start_ms` (#774).
    assert.deepEqual(doTheSameDescriptor(kind, presale("open", NOW + 2, NOW + 1), NOW), viewSale, `${kind} before start`);
    // An open sale whose end has passed (or is now) takes no more commits.
    assert.deepEqual(doTheSameDescriptor(kind, presale("open", NOW), NOW), viewSale, kind);
    assert.deepEqual(doTheSameDescriptor(kind, presale("open", NOW - 1), NOW), viewSale, kind);
    for (const lifecycle of ["pending", "funded", "cancelled", "migrated", "some_future_state"]) {
      assert.deepEqual(doTheSameDescriptor(kind, presale(lifecycle), NOW), viewSale, `${kind} ${lifecycle}`);
    }
  }
  for (const kind of ["trade_buy", "trade_sell"]) {
    assert.deepEqual(doTheSameDescriptor(kind, presale("migrated"), NOW), { ...viewSale, kind: "buy" }, kind);
  }
  for (const kind of ["launch_buy", "boost_mint", "something_new"]) {
    assert.equal(doTheSameDescriptor(kind, presale("open"), NOW), null, kind);
  }
  assert.equal(doTheSameDescriptor("presale_commit", null, NOW), null);
});

test("T-005-AC-6: cursors round-trip; tampered cursors and out-of-range limits are invalid_parameter", () => {
  for (const position of [
    { occurredAtMs: 0, entryId: "a:0:0:0:0" },
    { occurredAtMs: NOW, entryId: `l:${PRESALE}:funded` },
    { occurredAtMs: NOW, entryId: `m:${PRESALE}:raise:100.5` },
  ]) {
    const cursor = encodeItemCursor(position);
    assert.match(cursor, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{8}$/);
    assert.deepEqual(decodeItemCursor(cursor), position);
  }
  const cursor = encodeItemCursor({ occurredAtMs: NOW, entryId: "a:5000:1:0:0" });
  const [body, check] = cursor.split(".");
  const forged = Buffer.from(JSON.stringify([1, NOW + 1, "a:5000:1:0:0"])).toString("base64url");
  const flipped = `${body.slice(0, 5)}${body[5] === "A" ? "B" : "A"}${body.slice(6)}.${check}`;
  for (const bad of [
    "", "garbage", `${body}`, `${body}.`, `${body}.${check}.x`, flipped, `${forged}.${check}`, `${body}.AAAAAAAA`,
    `${body}x.${check}`, "x".repeat(2_000),
    // Correct check values around bodies this codec would never produce (the check is not a secret).
    ...[[2, NOW, "a:1:1:1:1"], [1, -1, "a:1:1:1:1"], [1, 1.5, "a:1:1:1:1"], [1, NOW, "z:1"], [1, NOW], { a: 1 }].map((value) => {
      const raw = Buffer.from(JSON.stringify(value)).toString("base64url");
      return `${raw}.${createHash("sha256").update(`social-feed-cursor:${raw}`).digest("base64url").slice(0, 8)}`;
    }),
    `bm90IGpzb24.${createHash("sha256").update("social-feed-cursor:bm90IGpzb24").digest("base64url").slice(0, 8)}`,
  ]) {
    assert.throws(() => decodeItemCursor(bad), (error: unknown) =>
      error instanceof SocialRouteError && error.code === "invalid_parameter" && error.extra.parameter === "cursor", bad);
  }

  assert.equal(parseItemLimit(null), 20);
  assert.equal(parseItemLimit(undefined), 20);
  assert.equal(parseItemLimit("1"), 1);
  assert.equal(parseItemLimit("50"), 50);
  for (const bad of ["51", "0", "-1", "", "1.5", "20abc", "050", "1e1", " 20", "999999"]) {
    assert.throws(() => parseItemLimit(bad), (error: unknown) =>
      error instanceof SocialRouteError && error.code === "invalid_parameter" && error.status === 400
        && error.extra.parameter === "limit", bad);
  }
  assert.deepEqual(parseItemPage(new URLSearchParams("")), { limit: 20, before: null });
  assert.deepEqual(parseItemPage(new URLSearchParams(`limit=3&cursor=${cursor}`)), {
    limit: 3, before: { occurredAtMs: NOW, entryId: "a:5000:1:0:0" },
  });
  assert.throws(() => parseItemPage(new URLSearchParams("limit=51")), SocialRouteError);

  const page = [entry({ entryId: "a:2:0:0:0", occurredAtMs: 2 }), entry({ entryId: "a:1:0:0:0", occurredAtMs: 1 })];
  assert.equal(nextItemCursor(page, 3), null);
  assert.deepEqual(decodeItemCursor(nextItemCursor(page, 2) ?? ""), { occurredAtMs: 1, entryId: "a:1:0:0:0" });
  assert.equal(nextItemCursor([], 1), null);
});

test("T-005-AC-1: identity fields only for a named entry; an unnamed big commit shows the short address", () => {
  assert.equal(shortAddress(WALLET), "0x1a2b…9f0e");
  const named = build({ namedAccountId: ACCOUNT });
  assert.deepEqual(named?.actor, {
    type: "account", callsign: "kai", display_name: "Kai", avatar_url: "https://i/kai.png", x_handle: "kai", verified: true,
    path: "/@kai",
  });
  // A private account's (unnamed) big commit: the address only, even though the wallet has an account.
  const unnamedBig = build();
  assert.deepEqual(unnamedBig?.actor, { type: "address", address: WALLET, short: "0x1a2b…9f0e" });
  assert.equal(unnamedBig?.big, true);
  // An unnamed entry that is not a presale post is never mapped.
  assert.equal(build({ usdValue: "10" }), null);
  assert.equal(build({ usdValue: null }), null);
  // A named account with no callsign yet: its wallet stands in, never a partial identity.
  const noCallsign = lookups({ identities: new Map([[ACCOUNT, {
    account_id: ACCOUNT, callsign: null, display_name: "Kai", avatar_url: null, x_handle: "kai", verified: false,
  }]]) });
  assert.deepEqual(build({ namedAccountId: ACCOUNT, usdValue: "10" }, SOCIAL_CONFIG_DEFAULTS, noCallsign)?.actor, {
    type: "address", address: WALLET, short: "0x1a2b…9f0e",
  });
  // Lifecycle and milestone posts have no actor and no amounts.
  const lifecycle = build({
    entryId: `l:${PRESALE}:funded`, source: "lifecycle", kind: "presale_funded", actor: null, activityId: null,
    quoteType: null, quoteAmount: null, usdValue: null, usdPriceAsOfMs: null,
  });
  assert.equal(lifecycle?.actor, null);
  assert.equal(lifecycle?.amounts, null);
  assert.equal(lifecycle?.presale_post, true);
  assert.equal(lifecycle?.big, false);
  const milestone = build({
    entryId: `m:${PRESALE}:participants:100`, source: "milestone", kind: "milestone_participants", actor: null,
    digest: null, activityId: null, quoteType: null, quoteAmount: null, usdValue: null, usdPriceAsOfMs: null,
    milestoneValue: "100",
  });
  assert.equal(milestone?.milestone_value, "100");
  for (const item of [named, unnamedBig, lifecycle, milestone]) valid(item);
});

test("T-005-AC-2: big and presale_post follow the thresholds passed for this read", () => {
  const raised: SocialConfig = { ...SOCIAL_CONFIG_DEFAULTS, big_commit_usd: "20000.01", big_trade_usd: "500" };
  const commit = { namedAccountId: ACCOUNT, usdValue: "20000" };
  assert.deepEqual([build(commit)?.big, build(commit)?.presale_post], [true, true]);
  assert.deepEqual([build(commit, raised)?.big, build(commit, raised)?.presale_post], [false, false]);
  // Without a name the commit is no longer shown at all.
  assert.equal(build({ usdValue: "20000" }, raised), null);
  const trade = { kind: "trade_buy", product: "market", namedAccountId: ACCOUNT, usdValue: "999.99" };
  assert.deepEqual([build(trade)?.big, build(trade, raised)?.big, build(trade, raised)?.presale_post], [false, true, true]);
  // Exactly at the threshold is big; null USD never is; a claim never is.
  assert.equal(build({ ...trade, usdValue: "1000" })?.big, true);
  assert.equal(build({ ...trade, usdValue: null })?.big, false);
  assert.equal(build({ kind: "presale_claim", namedAccountId: ACCOUNT, usdValue: "50000" })?.big, false);
  // A trade of a coin without a presale is not a presale post.
  assert.equal(build({ ...trade, usdValue: "5000", presaleId: null })?.big, false);
});

test("T-005-AC-3: amounts carry the stored USD unrounded (at most 12 places), null when the indexer stored none", () => {
  assert.deepEqual(build({ namedAccountId: ACCOUNT })?.amounts, {
    quote: "20000000000", quote_symbol: "USDC", quote_decimals: 6, usd: "20000", tokens: null, quote_refund: null,
  });
  assert.equal(build({ namedAccountId: ACCOUNT, usdValue: "17.505" })?.amounts?.usd, "17.505");
  // A dust trade keeps its cents' fraction, so its price per token is never $0 (live QA 2026-11-25).
  assert.equal(build({ namedAccountId: ACCOUNT, usdValue: "0.000100000000000000" })?.amounts?.usd, "0.0001");
  valid(build({ namedAccountId: ACCOUNT, usdValue: "0.000100000000000000" }));
  assert.equal(build({ namedAccountId: ACCOUNT, usdValue: "0.00000000000049" })?.amounts?.usd, "0");
  assert.equal(build({ namedAccountId: ACCOUNT, usdValue: null })?.amounts?.usd, null);
  // An amount in another quote than the presale's carries no symbol rather than a wrong one.
  const other = build({ namedAccountId: ACCOUNT, quoteType: "0x2::sui::SUI" })?.amounts;
  assert.deepEqual([other?.quote_symbol, other?.quote_decimals], [null, null]);
});

test("why, reactions and through come from the lookups; reactions list configured keys only, zeros included", () => {
  const map = lookups({
    whys: new Map([["a:5000:1:0:0", { why_id: "00000000-0000-4000-8000-0000000000aa", text: "Team shipped on time twice." }]]),
    reactions: new Map([["a:5000:1:0:0", new Map([["fire", 12], ["rocket", 3], ["retired", 9]])]]),
    through: new Map([["a:5000:1:0:0", { people: 4, volume_usd: "1250.00" }]]),
  });
  const item = buildItem(entry({ namedAccountId: ACCOUNT }), map, CONTEXT);
  assert.deepEqual(item?.why, { why_id: "00000000-0000-4000-8000-0000000000aa", text: "Team shipped on time twice." });
  // OA-5: the configured set is the rocket alone; stored rows of other keys are not shown.
  assert.deepEqual(item?.reactions, { rocket: 3 });
  assert.deepEqual(Object.keys(item?.reactions ?? {}), ["rocket"]);
  assert.deepEqual(item?.through, { people: 4, volume_usd: "1250.00" });
  assert.deepEqual(item?.do_the_same, { kind: "commit", enabled: true, label: "Blast", href: null });
  valid(item);
  const bare = build({ namedAccountId: ACCOUNT, entryId: "a:5000:2:0:0" });
  assert.deepEqual([bare?.why, bare?.through], [null, { people: 0, volume_usd: "0.00" }]);
  // Unknown presale (not indexed yet): no chip, no action.
  const orphan = build({ namedAccountId: ACCOUNT, presaleId: `0x${"cd".repeat(32)}` });
  assert.deepEqual([orphan?.presale, orphan?.do_the_same, orphan?.amounts?.quote_symbol], [null, null, null]);
  valid(orphan);
});

test("T-005-AC-7: the schema accepts open kinds and refuses identity on an address actor", () => {
  const launch = build({ kind: "launch_buy", product: "launchpad", namedAccountId: ACCOUNT, presaleId: null });
  assert.equal(launch?.kind, "launch_buy");
  assert.equal(launch?.do_the_same, null);
  valid(launch);
  const named = build({ namedAccountId: ACCOUNT });
  assert.ok(named);
  const future = { ...named, kind: "perp_long", do_the_same: { kind: "long", enabled: true, label: "Long too", href: null } };
  valid(future);
  const unnamed = build();
  assert.ok(unnamed);
  for (const leak of [{ callsign: "kai" }, { display_name: "Kai" }, { avatar_url: "x" }, { x_handle: "kai" }, { verified: true }, { path: "/@kai" }]) {
    const result = validator.validate("feed-item", { ...unnamed, actor: { ...unnamed.actor, ...leak } });
    assert.equal(result.valid, false, JSON.stringify(leak));
  }
  assert.equal(validator.validate("feed-item", { ...unnamed, viewer_reaction: "fire" }).valid, false);
  assert.equal(validator.validate("feed-item", { ...unnamed, through: { people: 1, volume_usd: "1.5" } }).valid, false);
});

function recorder(rows: Record<string, QueryResultRow[]>): ReadableDatabase & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    read: async <Row extends QueryResultRow>(text: string) => {
      calls.push(text);
      const key = Object.keys(rows).find((name) => text.includes(name));
      return { rows: key ? rows[key] : [] } as unknown as QueryResult<Row>;
    },
  };
}

test("toItems reads a fixed number of times per page and nothing for an empty page", async () => {
  const empty = recorder({});
  assert.deepEqual(await toItems(empty, [], CONTEXT), []);
  assert.equal(empty.calls.length, 0);
  const db = recorder({
    "FROM chain_read_v1.presales": [presaleRow({ lifecycle: "funded", end_ms: String(NOW - 1) })],
  });
  const entries = Array.from({ length: 30 }, (_, n) => entry({ entryId: `a:5000:${n}:0:0`, namedAccountId: n % 2 ? ACCOUNT : null }));
  const items = await toItems(db, entries, CONTEXT);
  // Presales, identities, whys, reactions, through: no lifecycle or milestone post, so no backers read.
  assert.equal(db.calls.length, 5);
  // The identity row is missing here, so named entries fall back to the address; every item is a big post.
  assert.equal(items.length, 30);
  assert.ok(items.every((item) => item.actor?.type === "address" && item.do_the_same?.enabled === false));
});

test("readAsOf picks the slowest pipeline and is null while one has committed nothing", async () => {
  const row = (market: [number, number] | null, presale: [number, number] | null, observed = 10_000) => recorder({
    "chain_read_v1.watermark": [{
      market_checkpoint: market ? String(market[0]) : null, market_timestamp_ms: market ? String(market[1]) : null,
      presale_checkpoint: presale ? String(presale[0]) : null, presale_timestamp_ms: presale ? String(presale[1]) : null,
      observed_ms: String(observed),
    }],
  });
  assert.deepEqual(await readAsOf(row([120, 9_000], [100, 7_000])), { checkpoint: 100, timestamp_ms: 7_000, lag_ms: 3_000 });
  assert.deepEqual(await readAsOf(row([90, 6_000], [100, 7_000])), { checkpoint: 90, timestamp_ms: 6_000, lag_ms: 4_000 });
  assert.deepEqual(await readAsOf(row([90, 12_000], [91, 12_000])), { checkpoint: 90, timestamp_ms: 12_000, lag_ms: 0 });
  assert.equal(await readAsOf(row([90, 6_000], null)), null);
  assert.equal(await readAsOf(recorder({})), null);
  const asOf = await readAsOf(row([120, 9_000], [100, 7_000]));
  assert.deepEqual(validator.validate("as-of", asOf).errors, []);
});

test("UI-02/03: a presale chip carries its facts and Blast's team check (R3-23); the Quote price only while fresh", () => {
  const map = lookups({ presales: new Map([[PRESALE, presaleRow({ quote_usd: "0.9998", quote_usd_as_of_ms: String(NOW - 120_000), verified_team: true })]]) });
  const item = build({ namedAccountId: ACCOUNT }, SOCIAL_CONFIG_DEFAULTS, map);
  assert.deepEqual(item?.presale, {
    presale_id: PRESALE, coin_type: `${PRESALE}::coin::XYZ`, symbol: "XYZ", name: "Xyz", icon_url: "https://i/xyz.png", lifecycle: "open", decimals: 9,
    venue: "cetus", start_ms: NOW - 86_400_000, end_ms: NOW + 3_600_000, raise_target: "400000000000",
    raised: "399000000000", participants: 2216, quote_symbol: "USDC", quote_decimals: 6, quote_usd: "0.9998",
    market: null, verified_team: true,
  });
  valid(item);
  // 120 s old is still fresh; one millisecond more is not (spec AC-112).
  const stale = lookups({ presales: new Map([[PRESALE, presaleRow({ quote_usd: "0.9998", quote_usd_as_of_ms: String(NOW - 120_001) })]]) });
  assert.equal(build({ namedAccountId: ACCOUNT }, SOCIAL_CONFIG_DEFAULTS, stale)?.presale?.quote_usd, null);
});

test("UI-02/03 (OA-9): a named commit of a migrated presale is a call with the coin's multiple", () => {
  const migrated = (extra: Partial<PresaleLookup> = {}) => lookups({
    presales: new Map([[PRESALE, presaleRow({
      lifecycle: "migrated", end_ms: String(NOW - 86_400_000), presale_price_quote: "0.0005",
      quote_usd: "1", quote_usd_as_of_ms: String(NOW - 5_000), sale_usd: "0.0021", sale_usd_as_of_ms: String(NOW - 4_000),
      ...extra,
    })]]),
  });
  const call = build({ namedAccountId: ACCOUNT, usdValue: "500" }, SOCIAL_CONFIG_DEFAULTS, migrated());
  assert.equal(call?.call, true);
  assert.deepEqual(call?.presale?.market, {
    presale_price_usd: "0.0005", price_usd: "0.0021", price_as_of_ms: NOW - 4_000, multiple: "4.2000",
  });
  assert.equal(call?.do_the_same?.label, "View presale");
  valid(call);
  // Below the presale price the multiple is under one.
  const under = build({ namedAccountId: ACCOUNT, usdValue: "500" }, SOCIAL_CONFIG_DEFAULTS, migrated({ sale_usd: "0.0003" }));
  assert.equal(under?.presale?.market?.multiple, "0.6000");
  // A stale coin price: still a call, with no price and no multiple.
  const stale = build({ namedAccountId: ACCOUNT, usdValue: "500" }, SOCIAL_CONFIG_DEFAULTS,
    migrated({ sale_usd_as_of_ms: String(NOW - 121_000) }));
  assert.deepEqual(stale?.presale?.market, { presale_price_usd: "0.0005", price_usd: null, price_as_of_ms: null, multiple: null });
  assert.equal(stale?.call, true);
  // No token allocation in the view: no presale price, no multiple.
  const unknown = build({ namedAccountId: ACCOUNT, usdValue: "500" }, SOCIAL_CONFIG_DEFAULTS, migrated({ presale_price_quote: null }));
  assert.deepEqual([unknown?.presale?.market?.presale_price_usd, unknown?.presale?.market?.multiple], [null, null]);
  // The Quote's own price scales the presale price.
  const sui = build({ namedAccountId: ACCOUNT, usdValue: "500" }, SOCIAL_CONFIG_DEFAULTS, migrated({ quote_usd: "2" }));
  assert.deepEqual([sui?.presale?.market?.presale_price_usd, sui?.presale?.market?.multiple], ["0.001", "2.1000"]);
  // Not a call: an unnamed (big) commit, a claim, or a commit of a presale still open.
  assert.equal(build({ usdValue: "5000" }, SOCIAL_CONFIG_DEFAULTS, migrated())?.call, false);
  assert.equal(build({ kind: "presale_claim", namedAccountId: ACCOUNT }, SOCIAL_CONFIG_DEFAULTS, migrated())?.call, false);
  assert.equal(build({ namedAccountId: ACCOUNT })?.call, false);
  assert.equal(build({ namedAccountId: ACCOUNT })?.presale?.market, null);
});

test("UI-02/03: lifecycle and milestone posts carry their presale's named backers; other items carry none", () => {
  const backers = [
    { callsign: "mira", display_name: "Mira Chen", avatar_url: null, verified: true, path: "/@mira", usd: "2000.00" },
    { callsign: "omar", display_name: null, avatar_url: null, verified: false, path: "/@omar", usd: null },
  ];
  const map = lookups({ backers: new Map([[PRESALE, backers]]) });
  const lifecycle = build({
    entryId: `l:${PRESALE}:funded`, source: "lifecycle", kind: "presale_funded", actor: null, activityId: null,
    quoteType: null, quoteAmount: null, usdValue: null, usdPriceAsOfMs: null,
  }, SOCIAL_CONFIG_DEFAULTS, map);
  assert.deepEqual(lifecycle?.backers, backers);
  valid(lifecycle);
  const milestone = build({
    entryId: `m:${PRESALE}:participants:100`, source: "milestone", kind: "milestone_participants", actor: null,
    digest: null, activityId: null, quoteType: null, quoteAmount: null, usdValue: null, usdPriceAsOfMs: null, milestoneValue: "100",
  }, SOCIAL_CONFIG_DEFAULTS, lookups());
  assert.deepEqual(milestone?.backers, []);
  assert.equal(build({ namedAccountId: ACCOUNT }, SOCIAL_CONFIG_DEFAULTS, map)?.backers, null);
  assert.equal(build({ usdValue: "5000" }, SOCIAL_CONFIG_DEFAULTS, map)?.backers, null);
});

test("toItems reads the named backers once per page, only for the presales of its lifecycle and milestone posts", async () => {
  const db = recorder({
    "FROM chain_read_v1.presales": [presaleRow()],
    "row_number() OVER (PARTITION BY backed.presale_id": [
      { presale_id: PRESALE, usd: "1200.5", callsign: "ana", display_name: "Ana", avatar_url: null, verified: true },
    ],
  });
  const items = await toItems(db, [
    entry({ entryId: `l:${PRESALE}:opened`, source: "lifecycle", kind: "presale_opened", actor: null, activityId: null, quoteType: null,
      quoteAmount: null, usdValue: null, usdPriceAsOfMs: null }),
    entry({ namedAccountId: ACCOUNT }),
  ], CONTEXT);
  assert.equal(db.calls.length, 6);
  assert.deepEqual(items[0]?.backers, [
    { callsign: "ana", display_name: "Ana", avatar_url: null, verified: true, path: "/@ana", usd: "1200.50" },
  ]);
});
