import type { HappeningPresale, HappeningTapeEvent, SocialHappeningResponse } from "@blast/core/modules/social/contracts/happening.ts";
import type { FeedItemPresale } from "../../../../../../packages/core/src/modules/social/contracts/items.ts";

import { FIXTURE_NOW, fixturePresale } from "../feed-fixtures.ts";

/** Test data for Home's happening parts: the canonical UI's sample presales and tape. */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const id = (n: string) => `0x${n.padStart(64, "0")}`;

export function happeningPresale(presale: Partial<FeedItemPresale>, extra: Partial<Omit<HappeningPresale, "presale">> = {}): HappeningPresale {
  return { presale: fixturePresale(presale), interested: 0, window_raised: "0", launched_ms: null, ...extra };
}

export const TIDE = happeningPresale({
  presale_id: id("a4"), symbol: "TIDE", name: "Tidal", raise_target: "400000000000", raised: "398600000000", participants: 2_216, end_ms: FIXTURE_NOW + 76_000,
});
export const MRDN = happeningPresale({ presale_id: id("a0") });
export const CBLT = happeningPresale({
  presale_id: id("a2"), symbol: "CBLT", name: "Cobalt", lifecycle: "funded", raise_target: "250000000000", raised: "312500000000", participants: 2_140, venue: "bluefin",
});
export const KSTL = happeningPresale({
  presale_id: id("a1"), symbol: "KSTL", name: "Kestrel", lifecycle: "migrated",
  market: { presale_price_usd: "0.0005", price_usd: "0.0021", price_as_of_ms: FIXTURE_NOW, multiple: "4.2000" },
}, { launched_ms: FIXTURE_NOW - 6 * DAY });
export const SABL = happeningPresale({
  presale_id: id("a5"), symbol: "SABL", name: "Sable", lifecycle: "pending", raise_target: "400000000000", raised: "0", participants: 0,
  start_ms: Date.UTC(2026, 9, 14, 18), end_ms: Date.UTC(2026, 9, 18, 18),
}, { interested: 1_840 });

export function tapeEvent(extra: Partial<HappeningTapeEvent> = {}): HappeningTapeEvent {
  return {
    activity_id: "100:0:0:0",
    kind: "presale_commit",
    occurred_at_ms: FIXTURE_NOW - 12_000,
    actor: { type: "address", address: `0x0016${"7".repeat(56)}a95f`, short: "0x0016…a95f" },
    presale_id: TIDE.presale.presale_id,
    symbol: "TIDE",
    usd: "116.00",
    tokens: null,
    refund: null,
    quote_symbol: "USDC",
    ...extra,
  };
}

export const THEO_EVENT = tapeEvent({
  activity_id: "101:0:0:0",
  occurred_at_ms: FIXTURE_NOW - 2_000,
  actor: { type: "account", callsign: "theopark", display_name: "Theo Park", avatar_url: null, x_handle: null, verified: false, path: "/@theopark" },
  usd: "757.00",
});

export function happeningRead(extra: Partial<SocialHappeningResponse> = {}): SocialHappeningResponse {
  return {
    clock_ms: FIXTURE_NOW,
    last_hour: { wallets: 312, usd: "48200.00" },
    tape: [THEO_EVENT, tapeEvent()],
    fastest: [TIDE, MRDN],
    opening_soon: [SABL],
    today: [TIDE, MRDN, CBLT, KSTL, SABL],
    as_of: { checkpoint: 90_000, timestamp_ms: FIXTURE_NOW, lag_ms: 0 },
    ...extra,
  };
}
