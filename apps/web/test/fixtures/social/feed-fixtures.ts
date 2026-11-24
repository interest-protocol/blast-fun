import type { SocialFeedPage } from "@blast/core/modules/social/contracts/feed.ts";
import type { FeedItem, FeedItemPresale } from "../../../../../packages/core/src/modules/social/contracts/items.ts";

/** Feed items for component tests and the development fixtures (never production): one valid item per call, overridable. */

export const FIXTURE_NOW = 1_791_700_000_000;
export const FIXTURE_PRESALE_ID = `0x${"ab".repeat(32)}`;
export const FIXTURE_ADDRESS = `0x1a2b${"0".repeat(56)}9f0e`;

/** An open presale (Meridian, as the canonical UI's sample): $184,220 of $250,000 from 1,012 backers. */
export function fixturePresale(extra: Partial<FeedItemPresale> = {}): FeedItemPresale {
  return {
    presale_id: FIXTURE_PRESALE_ID,
    symbol: "MRDN",
    name: "Meridian",
    icon_url: "https://cdn.blast.fun/mrdn.png",
    lifecycle: "open",
    decimals: 9,
    venue: "cetus",
    start_ms: FIXTURE_NOW - 3 * 86_400_000,
    end_ms: FIXTURE_NOW + 6 * 3_600_000,
    raise_target: "250000000000",
    raised: "184220540000",
    participants: 1_012,
    quote_symbol: "USDC",
    quote_decimals: 6,
    quote_usd: "1",
    market: null,
    ...extra,
  };
}

export function feedItem(extra: Partial<FeedItem> = {}): FeedItem {
  return {
    entry_id: "a:5000:1:0:0",
    kind: "presale_commit",
    occurred_at_ms: FIXTURE_NOW - 6 * 60_000,
    presale: fixturePresale(),
    actor: {
      type: "account", callsign: "mirachen", display_name: "Mira Chen", avatar_url: "https://cdn.blast.fun/mira.png",
      x_handle: "mirachen", verified: true, path: "/@mirachen",
    },
    amounts: { quote: "2000000000", quote_symbol: "USDC", quote_decimals: 6, usd: "2000.00", tokens: null, quote_refund: null },
    digest: "8Fq".padEnd(44, "1"),
    milestone_value: null,
    presale_post: true,
    big: true,
    why: { why_id: "00000000-0000-4000-8000-0000000000aa", text: "Been using their app for months. First presale I have joined with real size." },
    reactions: { rocket: 41 },
    through: { people: 6, volume_usd: "3150.00" },
    do_the_same: { kind: "commit", enabled: true, label: "Blast", href: null },
    call: false,
    backers: null,
    ...extra,
  };
}

export function feedPage(extra: Partial<SocialFeedPage> = {}): SocialFeedPage {
  return {
    items: [feedItem(), feedItem({ entry_id: "a:4999:1:0:0", big: false, why: null })],
    next_cursor: "cursor-1",
    as_of: { checkpoint: 40_000, timestamp_ms: FIXTURE_NOW - 1_000, lag_ms: 1_000 },
    ...extra,
  };
}
