import { proofHistory, proofThread } from "./redesign-fixtures";
import { feedItem } from "../social/feed-fixtures";
import type { HomeDiscussionPage } from "@blast/core/modules/social/contracts/home.ts";

/** Simulated public activity spread across the chart; never a production membership list. */
export function chartTradesFixture(coinType: string) {
  const history = proofHistory(coinType, true);
  const page = proofThread("LUMN");
  const start = history.points[0]![0];
  const end = history.points.at(-1)![0];
  const ratios = [0.2, 0.35, 0.55, 0.75, 0.85];
  const participants = page.participants.map((participant, index) => ({
    ...participant,
    events: participant.events!.map(event => ({ ...event, activity_id: `9:${index + 1}:0:0`, entry_id: `a:9:${index + 1}:0:0`, occurred_at_ms: Math.round(start + (end - start) * ratios[index]!) })),
  }));
  const mara = participants.find(row => row.actor.type === "account" && row.actor.callsign === "maralin")!;
  mara.events.push({ ...mara.events[0]!, activity_id: "9:9999:0:0", entry_id: "a:9:9999:0:0", kind: "trade_buy", occurred_at_ms: Math.round(start + (end - start) * 0.35) });
  return { ...page, participants };
}

/** Explicit demo authors and prose for the people-on-chart proof; no production fallbacks. */
export function chartPostsFixture(coinType: string, presaleId: string): HomeDiscussionPage {
  const history = proofHistory(coinType, true);
  const activity = chartTradesFixture(coinType);
  const mara = activity.participants.find(row => row.actor.type === "account" && row.actor.callsign === "maralin")!;
  const ines = activity.participants.find(row => row.actor.type === "account" && row.actor.callsign === "inesduarte")!;
  const event = mara.events[0]!;
  const at = (ratio: number) => Math.round(history.points[0]![0] + (history.points.at(-1)![0] - history.points[0]![0]) * ratio);
  const presale = { ...feedItem().presale!, presale_id: presaleId };
  return { presale_id: presaleId, total: 3, next_cursor: null, as_of: activity.as_of, items: [
    feedItem({ entry_id: event.entry_id, kind: event.kind, occurred_at_ms: event.occurred_at_ms, actor: mara.actor, presale, call: false, why: { why_id: "chart-sell-why", text: "Taking some profit after the rally. Keeping a smaller position while I watch liquidity and holder concentration." } }),
    feedItem({ entry_id: "a:9001:1:0:0", kind: "presale_commit", occurred_at_ms: at(.25), actor: mara.actor, presale, call: true, why: { why_id: "chart-call-why", text: "Backing the community early. The product has shipped; now I want to see sustained usage beyond launch." } }),
    feedItem({ entry_id: "a:9002:1:0:0", kind: "presale_commit", occurred_at_ms: at(.7), actor: ines.actor, presale, call: false, why: { why_id: "chart-thesis-why", text: "Watching how liquidity holds through the next unlock. A growing holder base matters more to me than one green candle." } }),
  ] };
}
