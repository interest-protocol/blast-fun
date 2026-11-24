import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { BidSlotContext } from "../coin/CoinExecution";
import { openingBidActions } from "./opening-slot";

const context: BidSlotContext = {
  launchId: `0x${"a1".repeat(32)}`,
  coinType: `0x${"4d".repeat(32)}::froggy::FROGGY`,
  round: {
    startsAtMs: 1_790_200_000_000,
    endsAtMs: 1_790_203_600_000,
    totalQuote: 125_500_000_000n,
    quoteType: "0x2::sui::SUI",
    readAtMs: 1_790_200_600_000,
  },
  bidders: { count: 2, stale: true, live: null },
};

const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

test("signed out on the coin page, the round's facts come from the launch object read for this request, with the pro-rata rules and no Join", () => {
  const bid = openingBidActions({ status: "unavailable", reason: "Joining the opening round opens once this app serves a released Blast deployment." }).bid;
  assert.ok(bid);
  const html = renderToStaticMarkup(<>{bid(context)}</>);
  const text = textOf(html);
  assert.match(text, /Started 23 Sept ’26/);
  assert.match(text, /Ends 23 Sept ’26/);
  assert.match(text, /Time left until 23 Sept ’26/);
  assert.match(text, /Total committed 125\.5 SUI/);
  assert.match(text, /Bidders 2 \(indexed; may be behind\)/);
  assert.match(text, /allocated pro rata/);
  assert.match(text, /Token amount is unknown until settlement/);
  assert.match(html, /data-join-unavailable=""/);
  assert.doesNotMatch(html.replace(/<button[^>]*data-inspect-value=""[^>]*>/g, ""), /<button|<input/);
});

test("a round in a Quote other than SUI shows its pot in atoms of that Quote", () => {
  const bid = openingBidActions({ status: "unavailable", reason: "x" }).bid!;
  const text = textOf(renderToStaticMarkup(<>{bid({ ...context, round: { ...context.round, quoteType: "0x5::usdc::USDC" } })}</>));
  assert.match(text, /Total committed 125500000000 atoms of 0x5::usdc::USDC/);
});

test("an ended round on the coin page says why settling cannot be signed here, not joining, and offers no Settle control", () => {
  const bid = openingBidActions(
    { status: "unavailable", reason: "Joining the opening round opens once this app serves a released Blast deployment." },
    { status: "unavailable", reason: "Settling the opening round opens once this app serves a released Blast deployment." },
  ).bid!;
  const ended = { ...context, round: { ...context.round, readAtMs: context.round.endsAtMs! + 1_000 } };
  const html = renderToStaticMarkup(<>{bid(ended)}</>);
  const text = textOf(html);
  assert.match(text, /Settling the opening round opens once this app serves a released Blast deployment/);
  assert.doesNotMatch(text, /Joining the opening round opens/);
  assert.doesNotMatch(html.replace(/<button[^>]*data-inspect-value=""[^>]*>/g, ""), /<button|<input/);
  // Before the deadline the reason stays about joining.
  assert.match(textOf(renderToStaticMarkup(<>{bid(context)}</>)), /Joining the opening round opens/);
});
