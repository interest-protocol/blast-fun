import assert from "node:assert/strict";
import test from "node:test";

import { isProfileCalls } from "#web/components/social/profile/profile-client.ts";
import { callRow } from "#web/components/social/profile/profile-model.ts";
import { fillPercent } from "@blast/core/lib/format.ts";
import type { ProfileCall, SocialMePresales } from "@blast/core/modules/social/contracts/profile-page.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { editableDisplayName } from "@blast/server/modules/social/profile-edit/route.ts";
import { PROFILE_PICTURE_IMAGE } from "@blast/server/modules/social/profile-edit/picture.ts";
import { sanitizeSquareImage, sniffSquareImageType } from "@blast/server/modules/social/square-image.ts";
import { callOf, priceString, sortCalls, trackRecordOf } from "@blast/server/modules/social/profiles/calls.ts";
import { presaleFactsOf, type PresaleFacts } from "@blast/server/modules/social/profiles/presales.ts";
import { decodeThesisCursor, encodeThesisCursor } from "@blast/server/modules/social/profiles/theses.ts";

const NOW = 1_790_000_000_000;

function facts(lifecycle: string, over: Partial<Parameters<typeof presaleFactsOf>[0]> = {}): PresaleFacts {
  return presaleFactsOf({
    presale_id: `0x${"5".padStart(64, "0")}`, sale_symbol: "KSTL", sale_name: "Kestrel", sale_icon_url: "https://i/k.png",
    quote_symbol: "USDC", quote_decimals: 6, sale_decimals: 9, lifecycle, venue: "cetus", start_ms: "0", end_ms: String(NOW + 1_000),
    raise_target: "250000000000", total_commitments: "184220540000", price: "0.0021", price_as_of_ms: String(NOW - 5_000),
    claims_net: "800000000", claims_committed: "1000000000", claims_tokens: "1600000000000000", quote_price: "1", quote_price_as_of_ms: String(NOW - 5_000), launched_ms: null, first_unlock_ms: null, ...over,
  }, NOW);
}

const commit = (usd: string) => ({ presale_id: "x", quote_atoms: String(Number(usd) * 1e6), usd, unpriced: "0", last_ms: String(NOW - 1) });

test("UI-06: a presale's profile status and fill (§0.2: floored below 100, rounded above)", () => {
  assert.equal(facts("open").presale.status, "open");
  assert.equal(facts("open", { start_ms: String(NOW + 1) }).presale.status, "pending", "open on chain, its start ahead (#588)");
  assert.equal(fillPercent(99.7, 100), 99);
  assert.equal(fillPercent(124.6, 100), 125);
  assert.equal(fillPercent(1, 0), 0);
  assert.equal(facts("open").presale.fill_pct, 73);
});

test("R3-85: `/me/presales` carries each presale's launch and first unlock (the compact stepper's progress), null until read", () => {
  // The read: the `migrated` lifecycle time and the earliest cliff end, as numbers; null without either.
  const trading = facts("migrated", { launched_ms: String(NOW - 6 * 86_400_000), first_unlock_ms: String(NOW + 84 * 86_400_000) }).presale;
  assert.deepEqual([trading.launched_ms, trading.first_unlock_ms], [NOW - 6 * 86_400_000, NOW + 84 * 86_400_000]);
  assert.deepEqual([facts("open").presale.launched_ms, facts("open").presale.first_unlock_ms], [null, null]);
  // The contract: both are required, each an integer or null, on every presale the response carries.
  const validator = createSocialValidator();
  const body = (presale: unknown) => ({ created: [], positions: [], watchlist: [presale], coins: [], vestings: [] });
  const open = facts("open").presale;
  assert.deepEqual(validator.validate("me-presales-response", { created: [], positions: [], watchlist: [trading], coins: [], vestings: [] } satisfies SocialMePresales).errors, []);
  assert.deepEqual(validator.validate("me-presales-response", body(open)).errors, []);
  for (const field of ["launched_ms", "first_unlock_ms"] as const) {
    const missing: Record<string, unknown> = { ...trading };
    delete missing[field];
    assert.equal(validator.validate("me-presales-response", body(missing)).valid, false, `${field} missing`);
    assert.equal(validator.validate("me-presales-response", body({ ...trading, [field]: "1" })).valid, false, `${field} as text`);
  }
  assert.deepEqual(validator.validate("profile-calls-response", { calls: [{ ...callOf(commit("300"), facts("migrated"), NOW), presale: trading }], track_record: { presales_backed: 1, launched: 1, pnl_usd: null }, as_of: { checkpoint: 1, timestamp_ms: NOW, lag_ms: 0 } }).errors, []);
});

test("UI-06 (OA-9): a trading call: entry from claims, fresh price, multiple, pro-rata value and PnL", () => {
  // Net 800 USDC for 1.6M tokens: $0.0005 a token; now $0.0021: 4.2×; 80% filled.
  const call = callOf(commit("300"), facts("migrated"), NOW);
  assert.deepEqual([call.entry_price_usd, call.price_usd, call.multiple], ["0.0005", "0.0021", "4.2000"]);
  // 300 × 20% back + 300 × 80% × 4.2.
  assert.deepEqual([call.value_usd, call.pnl_usd], ["1068.00", "768.00"]);
  // A stale price (over 120 s) or no claims yet: no multiple, no value.
  assert.equal(callOf(commit("300"), facts("migrated", { price_as_of_ms: String(NOW - 121_000) }), NOW).multiple, null);
  assert.equal(callOf(commit("300"), facts("migrated", { claims_tokens: null }), NOW).entry_price_usd, null);
  // Cancelled: everything comes back; open: not known yet.
  assert.deepEqual([callOf(commit("250"), facts("cancelled"), NOW).value_usd, callOf(commit("250"), facts("cancelled"), NOW).pnl_usd], ["250.00", "0.00"]);
  assert.equal(callOf(commit("100"), facts("open"), NOW).value_usd, null);
  assert.equal(priceString(0.00000123456789), "0.00000123457");
  assert.equal(priceString(4.2), "4.2");
});

test("UI-06: calls sort trading first by multiple, then newest; the track record never sums a partial PnL", () => {
  const make = (status: "trading" | "open" | "cancelled", multiple: string | null, pnl: string | null, last: number): ProfileCall => ({
    presale: { ...facts("open").presale, presale_id: `0x${String(last).padStart(64, "0")}`, status },
    committed_usd: "100.00", committed_atoms: "100000000", entry_price_usd: null, price_usd: null, multiple, value_usd: pnl, pnl_usd: pnl, last_commit_ms: last, series: null,
  });
  const calls = [make("open", null, null, 9), make("trading", "0.6000", "-40.00", 1), make("trading", "4.2000", "320.00", 2), make("cancelled", null, "0.00", 5)];
  assert.deepEqual(sortCalls(calls).map((call) => call.last_commit_ms), [2, 1, 9, 5]);
  assert.deepEqual(trackRecordOf(calls), { presales_backed: 4, launched: 2, pnl_usd: "280.00" });
  assert.deepEqual(trackRecordOf([...calls, make("trading", null, null, 3)]).pnl_usd, null);
  assert.deepEqual(trackRecordOf([make("open", null, null, 1)]), { presales_backed: 1, launched: 0, pnl_usd: null });
});

test("UI-06: the theses cursor round-trips and refuses anything it did not make", () => {
  const position = { rockets: 3, occurredAtMs: NOW, entryId: "a:100:0:0:0" };
  assert.deepEqual(decodeThesisCursor(encodeThesisCursor(position)), position);
  const cursor = encodeThesisCursor(position);
  for (const bad of [`${cursor}x`, cursor.replace(/^./, "A"), "abc", encodeThesisCursor({ ...position, entryId: "l:0x1:opened" })]) {
    assert.throws(() => decodeThesisCursor(bad), { code: "invalid_parameter" });
  }
});

test("UI-06 (OA-14): a display name is trimmed, single-spaced, 1 to 32 code points, without control or format characters", () => {
  assert.equal(editableDisplayName("  Kai \t  Moreno "), "Kai Moreno");
  assert.equal(editableDisplayName("🚀".repeat(32)), "🚀".repeat(32));
  for (const bad of ["", "  ", "x".repeat(33), "Kai\u0007", "Kai\u200d", null, 7]) assert.equal(editableDisplayName(bad), null);
});

test("UI-06: a picture upload is sniffed, decoded and re-encoded as a 400×400 WebP; anything else is refused with a reason", async () => {
  const { default: sharp } = await import("sharp");
  const png = await sharp({ create: { width: 640, height: 320, channels: 4, background: "#d61b70" } })
    .withMetadata({ exif: { IFD0: { Artist: "someone" } } }).png().toBuffer();
  assert.equal(sniffSquareImageType(png), "image/png");
  const result = await sanitizeSquareImage(png, "image/png", PROFILE_PICTURE_IMAGE);
  assert.ok(result.ok);
  const meta = await sharp(result.bytes).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height, meta.exif], ["webp", 400, 400, undefined]);
  assert.deepEqual(await sanitizeSquareImage(png, "image/jpeg", PROFILE_PICTURE_IMAGE), { ok: false, reason: "type" });
  assert.deepEqual(await sanitizeSquareImage(png, "image/svg+xml", PROFILE_PICTURE_IMAGE), { ok: false, reason: "type" });
  assert.deepEqual(await sanitizeSquareImage(Buffer.from("<svg/>"), "image/png", PROFILE_PICTURE_IMAGE), { ok: false, reason: "type" });
  const tiny = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#fff" } }).png().toBuffer();
  assert.deepEqual(await sanitizeSquareImage(tiny, "image/png", PROFILE_PICTURE_IMAGE), { ok: false, reason: "dimensions" });
  const broken = Buffer.concat([png.subarray(0, 64), Buffer.alloc(64)]);
  assert.deepEqual(await sanitizeSquareImage(broken, "image/png", PROFILE_PICTURE_IMAGE), { ok: false, reason: "undecodable" });
  const gif = await sharp({ create: { width: 80, height: 80, channels: 3, background: "#fff" } }).webp().toBuffer();
  assert.ok((await sanitizeSquareImage(gif, "image/webp", PROFILE_PICTURE_IMAGE)).ok);
});


test("unpriced public Backed commitments retain quote atoms through API validation and display", () => {
  const sale = facts("open", { quote_symbol: "TSUI", quote_decimals: 9, quote_price: null, quote_price_as_of_ms: null });
  const call = callOf({ presale_id: sale.presale.presale_id, quote_atoms: "50090000000001", usd: null, unpriced: "1", last_ms: String(NOW) }, sale, NOW);
  assert.equal(call.committed_usd, null);
  const body = { calls: [call], track_record: { presales_backed: 1, launched: 0, pnl_usd: null }, as_of: { checkpoint: 1, timestamp_ms: NOW, lag_ms: 0 } };
  assert.deepEqual(createSocialValidator().validate("profile-calls-response", body).errors, []);
  assert.equal(isProfileCalls(body), true);
  assert.equal(callRow(call).sub, "50,090.000000001 TSUI committed");
  assert.equal(callOf({ presale_id: "x", quote_atoms: "1", usd: "1", unpriced: "1", last_ms: String(NOW) }, sale, NOW).committed_usd, null, "a partial priced sum cannot become a complete commitment");
});
