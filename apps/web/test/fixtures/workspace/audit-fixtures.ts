import type { HomeDiscussionPage } from "@blast/core/modules/social/contracts/home.ts";
import { feedItem, FIXTURE_PRESALE_ID } from "../social/feed-fixtures";
import { proofCoins, proofThread } from "./redesign-fixtures";

export const auditPresaleId = FIXTURE_PRESALE_ID;
export const auditName = "Kestrel Community Coin With An Exceptionally Long Project Name";
// 32 bytes: the longest ticker a coin can carry (audit F29).
export const auditSymbol = "KESTREL_COMMUNITY_TOKEN_ULTRA_32";

export function auditThread() {
  const thread = proofThread("KSTL");
  return { ...thread, participants: thread.participants.map((person, index) => ({
    ...person,
    actor: person.actor.type === "account" ? { ...person.actor, display_name: index === 0 ? "Alexandria Constantinopoulos-Fernández" : "UnbrokenLongCommunityContributorNameWithoutSpaces" } : person.actor,
    events: (person.events ?? []).map(event => ({ ...event, quote: event.quote ? { ...event.quote, usd: index === 0 ? "123456789012345.678901" : index === 2 ? "0.000000000000000123" : event.quote.usd } : null })),
  })) };
}

export function auditHolders() {
  return { ...proofCoins.KSTL.top_holders!, holders: proofCoins.KSTL.top_holders!.holders.map(holder => ({ ...holder, actor: holder.actor.type === "account" ? { ...holder.actor, display_name: "Alexandria Constantinopoulos-Fernández" } : holder.actor })) };
}

export function auditPosts(presaleId: string, count = 7, older = false): HomeDiscussionPage {
  const now = Date.now();
  return { presale_id: presaleId, total: count, next_cursor: older ? null : "older", as_of: { checkpoint: 1, timestamp_ms: now, lag_ms: 0 }, items: Array.from({ length: count }, (_, index) => feedItem({
    entry_id: `a:${(older ? 4000 : 5000) - index}:1:0:0`,
    occurred_at_ms: now - (index + 1) * 60_000,
    actor: { type: "account", callsign: "alexandria", display_name: "Alexandria Constantinopoulos-Fernández", avatar_url: null, x_handle: null, verified: true, path: "/@alexandria" },
    presale: { ...feedItem().presale!, presale_id: presaleId, icon_url: proofCoins.KSTL.icon_url ?? "" },
    why: { why_id: `audit-${index}`, text: index === 0 ? "This is a thoughtful discussion of the launch, liquidity, allocation and the risks of concentrated ownership. ".repeat(8) : `${older ? "Older" : "Community"} update ${index + 1}: checking holder concentration and the vesting schedule before participating.` },
  })) };
}
