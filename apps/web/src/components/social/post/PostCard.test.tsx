import assert from "node:assert/strict";
import { readFileSync } from "#web/test/css-design-px.ts";
import test from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";

import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import type { FeedItem } from "@blast/core/modules/social/contracts/items.ts";

import { feedItem, fixturePresale, FIXTURE_ADDRESS, FIXTURE_NOW } from "../../../../test/fixtures/social/feed-fixtures.ts";
import { FeedOverlaysProvider } from "../feed-ui/shell-bridge";
import { seedTradeStoryPrices, tradeStoryItems } from "../../../../test/fixtures/social/home/trade-story.ts";
import { SocialViewerProvider } from "../SignInGate";
import { createTestQueryClient, withQueryClient } from "#web/lib/query/test-client.ts";
import { PostCard } from "./PostCard";
import { PostPage } from "./PostPage";
import { rocketCount, rocketLabel } from "./post-model";

/** UI-03: the post card's markup for each variant, rendered on the server as the app router would. */

function at(node: ReactNode, viewer?: string): string {
  const tree = viewer ? (
    <SocialViewerProvider signedIn callsign={viewer} getAccessToken={async () => "token"}>
      {node}
    </SocialViewerProvider>
  ) : node;
  return renderToStaticMarkup(<PathnameContext value="/">{tree}</PathnameContext>);
}

const card = (item: FeedItem, viewer?: string) => at(<PostCard item={item} nowMs={FIXTURE_NOW} />, viewer);
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");


/** The dots: base-ui's menu trigger (OA-28 M2b) rendered as the shared IconButton, closed in the server's HTML, with no inline style. */
function assertMoreButton(html: string, label?: string): void {
  const button = html.match(/<button [^>]*aria-label="More"[^>]*>/)?.[0] ?? "";
  for (const attribute of ['type="button"', 'aria-haspopup="menu"', 'aria-expanded="false"', 'data-ui-button=""', 'data-ui-icon=""', 'title="More"']) assert.ok(button.includes(attribute), `${label ?? ""} ${attribute} in ${button}`);
  assert.ok(!button.includes("style="), label);
}

/** A footer call to action: the neutral shared Button once its dialog is mounted, a `.btn-line` link before. */
const ctaButton = (label: string) => new RegExp(`<button aria-haspopup="dialog" type="button" class="button cta" data-ui-button="" data-ui-size="md" data-ui-variant="secondary">${label}</button>`);
const ctaLink = (label: string, href: string) => new RegExp(`<a class="btn btn-line cta" href="${href}">${label}</a>`);

test("§3.1 a named commit: avatar link, name with the rosette, @handle · 6m linked to Suiscan, BLAST $2,000 MRDN, the why", () => {
  const html = card(feedItem());
  // The shared card surface (lit top edge, hairline) carries the post.
  const post = [...JSDOM.fragment(html).children].find((node) => node.matches('article.card.post[data-surface=""]'));
  assert.ok(post);
  assert.equal(post.getAttribute("aria-labelledby"), "post-a-5000-1-0-0-head");
  assert.equal(post.getAttribute("data-entry-id"), "a:5000:1:0:0");
  assert.equal(post.getAttribute("data-kind"), "presale_commit");
  assert.match(html, /<a aria-label="Mira Chen" class="lead" href="\/@mirachen">/);
  assert.match(html, /<a class="name" id="post-a-5000-1-0-0-head" href="\/@mirachen"><span class="nm">Mira Chen<\/span><svg aria-label="Verified" class="verified" role="img"/);
  // R3-07: the handle has its own ellipsising span, so a long one can never push the timestamp out.
  assert.match(html, /<span class="meta metaH">@mirachen<\/span><span class="meta">· <a href="https:\/\/suiscan\.xyz\/mainnet\/tx\/8Fq1+" rel="noopener noreferrer" target="_blank" title="[^"]+ UTC"><time dateTime="[^"]+">6m<\/time>/);
  // R3-07: every mark carries its own key, so one coin's mark can be styled on its own.
  assert.match(html, /class="mk s20 mk-0x(ab)+"/);
  assert.match(text(html), /BLAST?\$2,000MRDN/i);
  assert.match(html, /<div class="actSummary"><span class="act">.*Blast<\/span><span class="actAmt" role="region" aria-label="Transaction amount" tabindex="0">\$2,000<\/span><\/div><a class="tchip" href="\/presale\/0x(ab)+">/s);
  assert.match(html, /<p class="why">Been using their app for months\. First presale I have joined with real size\.<\/p>/);
  assert.match(html, /<span class="thru" title="People who acted through this post">.*<b class="num">6<\/b> blasted too<span class="thruAmt"> · <span class="num">\$3\.2K<\/span>/s);
  // While the commit dialog is not built, "Blast" is a link to the presale page; with it, a dialog button.
  assert.match(html, ctaLink("Blast", "\\/presale\\/0x(ab)+"));
  const withDialog = at(<FeedOverlaysProvider value={{ openCommit: () => undefined }}><PostCard item={feedItem()} nowMs={FIXTURE_NOW} /></FeedOverlaysProvider>);
  assert.match(withDialog, ctaButton("Blast"));
  // The More menu button (OA-28 M2b: base-ui's trigger, closed).
  assertMoreButton(html);
});

test("§3.1: user text is plain text: a display name and a why with markup and a domain are never markup or links", () => {
  const html = card(feedItem({
    actor: { ...(feedItem().actor as Extract<FeedItem["actor"], { type: "account" }>), display_name: "<b>x</b> see blast.fun" },
    why: { why_id: "w", text: "<script>alert(1)</script> visit https://blast.fun" },
  }));
  assert.doesNotMatch(html, /<b>x<\/b>|<script>|href="https:\/\/blast\.fun"/);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt; see blast\.fun/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; visit https:\/\/blast\.fun/);
});

test("§3.1 own post: the You tag, no Follow, no call to action", () => {
  const html = card(feedItem(), "mirachen");
  assert.match(html, /<span class="you">You<\/span>/);
  assert.doesNotMatch(html, /<(?:a|button)\b[^>]*>Blast<|View presale|>Follow</);
});

test("§3.8 big commit: Big blast, the wallet's gradient and short address, no name link", () => {
  const html = card(feedItem({ actor: { type: "address", address: FIXTURE_ADDRESS, short: "0x1a2b…9f0e" }, why: null }));
  assert.match(html, /<span class="context"><svg[^>]*>.*<\/svg>Big blast<\/span>/s);
  assert.match(html, /<span class="lead"><span aria-hidden="true" class="wav"><svg[^>]*><defs><linearGradient id="wav-\d+"[^>]*><stop offset="0" stop-color="hsl\(\d+ 70% 66%\)"/);
  // No inline style anywhere: the page's CSP allows none.
  assert.doesNotMatch(html, / style="/);
  assert.match(html, /<span class="name addr" id="post-a-5000-1-0-0-head" title="0x1a2b0+9f0e">0x1a2b…9f0e<\/span><span class="meta">· <a/);
});

test("§3.4 call: CALL, backed at $0.0005, the call card with 4.2× and the empty sparkline place, View presale", () => {
  const presale = fixturePresale({
    symbol: "KSTL", name: "Kestrel", lifecycle: "migrated",
    market: { presale_price_usd: "0.0005", price_usd: "0.0021", price_as_of_ms: FIXTURE_NOW, multiple: "4.2000" },
  });
  const html = card(feedItem({ call: true, presale, do_the_same: { kind: "commit", enabled: false, label: "View presale", href: `/presale/${presale.presale_id}` } }));
  assert.match(html, /<span class="act">.*Call<\/span><\/div><a class="tchip"[^>]*>.*KSTL<\/a><span class="actAt">backed at \$0\.0005<\/span>/s);
  assert.doesNotMatch(html, /class="actAmt"/);
  assert.match(html, /<div class="callc">.*<b>Kestrel<\/b><span>Trading on .*\/dex\/cetus\.svg.*Cetus.* · now \$0\.0021<\/span>.*<span class="pnl up">4\.2×<\/span><span aria-hidden="true" class="spark" data-slot="call-sparkline"><\/span>/s);
  assert.match(html, ctaLink("View presale", "\\/presale\\/0x(ab)+"));
  // The why comes before the call card.
  assert.ok(html.indexOf('class="why"') < html.indexOf('class="callc"'));
});

test("§3.8 presale posts: the presale's mark with the Blast badge, Presale · 14m, headline, line and facepile", () => {
  const html = card(feedItem({
    kind: "milestone_participants", actor: null, amounts: null, why: null, milestone_value: "1000",
    occurred_at_ms: FIXTURE_NOW - 14 * 60_000, digest: null,
    backers: [
      { callsign: "luca", display_name: "Luca Romano", avatar_url: null, verified: true, path: "/@luca", usd: "25000.00" },
      { callsign: "ana", display_name: "Ana Souza", avatar_url: null, verified: true, path: "/@ana", usd: "1200.00" },
    ],
  }));
  assert.match(html, /<a aria-label="Meridian" class="lead leadMark" href="\/presale\/0x(ab)+"><span aria-hidden="true" class="mk mk-0x(ab)+">.*<span class="badge" title="Posted by Blast"><svg/s);
  assert.match(html, /<a class="name" id="[^"]+" href="\/presale\/0x(ab)+">Meridian<\/a><span class="meta">Presale · <time dateTime="[^"]+" title="[^"]+">14m<\/time><\/span>/);
  assert.match(html, /<p class="headline">1,000 people are in<\/p><p class="sub">Meridian passed 1,000 backers with 6 hours left\.<\/p>/);
  assert.match(html, /<a aria-label="Luca, \$25,000 in" class="face" href="\/@luca">.*<span aria-hidden="true" class="tip" role="tooltip"><b>Luca<\/b><span>@luca · \$25,000 in<\/span><\/span><\/a>/s);
  assert.match(html, /<span class="pileTxt"><span class="num">1,012<\/span> others are in<\/span>/);
  assert.doesNotMatch(html, />Follow</);
  assert.match(html, ctaLink("Blast", "\\/presale\\/0x(ab)+"));
});

test("§3.2 rocket: a visitor's links to sign-in; a signed-in viewer's is a toggle labelled with its count", () => {
  const visitor = card(feedItem());
  assert.match(visitor, /<a class="rocket" data-gated="sign-in" aria-label="Rocket, 41\. Sign in to react" href="\/sign-in\?next=%2F">|<a[^>]*aria-label="Rocket, 41\. Sign in to react"[^>]*href="\/sign-in\?next=%2F"/);
  const member = card(feedItem(), "kai");
  assert.match(member, /<button aria-label="Rocket, 41" aria-pressed="false" class="rocket" type="button"><svg[^>]*>.*<\/svg><span aria-hidden="true" class="roll"><span>41<\/span><\/span><\/button>/s);
  // No rockets: a centered icon-only target for both visitors and members.
  const empty = feedItem({ reactions: { rocket: 0 } });
  assert.match(card(empty, "kai"), /<button aria-label="Rocket" aria-pressed="false" class="rocket iconOnly" type="button">/);
  assert.match(card(empty), /<a[^>]*class="rocket iconOnly"[^>]*aria-label="Rocket\. Sign in to react"/);
  // The count with the viewer's own rocket: as read, then after a tap here.
  assert.equal(rocketCount(41, false, true), 42);
  assert.equal(rocketCount(41, true, true), 41);
  assert.equal(rocketCount(41, true, false), 40);
  assert.equal(rocketCount(0, true, false), 0);
  assert.equal(rocketLabel(1234), "Rocket, 1,234");
  assert.equal(rocketLabel(0), "Rocket");
});

test("unknown kinds render nothing; the permalink page shows the one card with a way home, or why it could not load", () => {
  assert.equal(card(feedItem({ kind: "launch_buy" })), "");
  const page = at(<PostPage postId="fixture" loaded={{ post: { item: feedItem(), as_of: { checkpoint: 1, timestamp_ms: FIXTURE_NOW, lag_ms: 0 } }, nowMs: FIXTURE_NOW }} />);
  assert.match(page, /<div class="backbar" data-back-bar=""><a aria-label="Back home" class="back" title="Back home" href="\/">/);
  // The title is the shared page header's.
  assert.match(page, /<header class="phead" data-page-head=""><div><h1>Post<\/h1>/);
  assert.equal(page.match(/<article /g)?.length, 1);
  const failed = at(<PostPage postId="fixture" loaded={null} />);
  assert.match(failed, /<div class="empty card" role="alert"><p class="title">This post couldn’t load<\/p>/);
});

test("T-021: the author's own item without a why offers Add why (collapsed to the one button); nobody else sees it", () => {
  const item = feedItem({ why: null });
  const own = card(item, "mirachen");
  assert.match(own, /<button class="btn btn-quiet btn-sm add" type="button">Add why<\/button>/);
  assert.doesNotMatch(own, /textarea/);
  assert.doesNotMatch(card(item, "kaimoreno"), /Add why/);
  assert.doesNotMatch(card(item), /Add why/);
  assert.doesNotMatch(card(feedItem(), "mirachen"), /Add why/);
});

test("§3.7 and T-022: the More menu stays closed on the first paint, so neither destructive item is in the server's markup", () => {
  for (const [viewer, label] of [["kaimoreno", "a reader"], ["mirachen", "the author"], [undefined, "a visitor"]] as const) {
    const html = card(feedItem(), viewer);
    // The dots button announces the menu; the menu itself only exists once it opens (it portals out of the card).
    assertMoreButton(html, label);
    assert.doesNotMatch(html, /Report post|Delete this why|role="menu"/, label);
  }
});

test("OA-24: phones show \"6 blasted too through this post · $3.2K\" under the footer, \"through you\" on the viewer's own post", () => {
  const html = card(feedItem());
  assert.match(html, /<div class="pfoot">.*<\/div><span class="mThru"><svg[^>]*>.*<\/svg>6 blasted too through this post · \$3\.2K<\/span><\/div><\/article>$/s);
  assert.match(card(feedItem(), "mirachen"), /<span class="mThru"><svg[^>]*>.*<\/svg>6 blasted too through you · \$3\.2K<\/span>/s);
  // Nobody through the post: no line at all.
  assert.doesNotMatch(card(feedItem({ through: { people: 0, volume_usd: "0.00" } })), /mThru|blasted too/);
});

test("OA-24: the phone line is hidden on wider screens and shown in compact tablet cards, where the footer's count hides", () => {
  const css = readFileSync(new URL("./PostCard.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const phone = css.slice(css.indexOf("@media (max-width: 1054px)"));
  const base = css.slice(0, css.indexOf("@media (max-width: 1054px)"));
  assert.match(base, /\.mThru \{ display: none; font-size: 13px; color: var\(--muted\); gap: 5px; align-items: center; padding: 0 0 6px; \}/);
  assert.match(base, /\.mThru svg \{ width: 15px; height: 15px; \}/);
  assert.match(phone, /\.thru \{ display: none; \}\s*\.mThru \{ display: flex; \}/);
});

test("R3-83-AC-1: trade posts draw oa41's line — BUY with its arrow, at $x · now +x%, Big buy, the why-now line, Buy too / View coin", () => {
  const [luca, big, , , , , , , theo] = tradeStoryItems(FIXTURE_NOW);
  const queries = createTestQueryClient();
  seedTradeStoryPrices(queries);
  const moved = (item: FeedItem) => at(withQueryClient(queries, <PostCard item={item} nowMs={FIXTURE_NOW} />));
  const buy = moved(luca!);
  assert.match(buy, /<span class="act"><svg[^>]*><path d="M7 17 17 7M9 7h8v8"><\/path><\/svg>Buy<\/span><span class="actAmt" role="region" aria-label="Transaction amount" tabindex="0">\$8,400<\/span><\/div><a class="tchip" href="\/presale\/0x0+de5191a1">/);
  assert.match(buy, /<span class="actAt">at \$0\.0019 · now <span class="actNow up">\+10\.5%<\/span><\/span><\/div>/);
  assert.match(buy, /<div class="pbody"><span class="context"><svg[^>]*><path d="M3\.5 16\.5 9 11l4 4 7\.5-7\.5"><\/path><path d="M15 7\.5h5\.5V13"><\/path><\/svg>Up 18\.4% today<\/span><div class="prow">/);
  assert.match(buy, ctaButton("Buy too"));
  assert.doesNotMatch(text(buy), /blasted too|bought too/);
  const bigBuy = moved(big!);
  assert.match(bigBuy, /now <span class="actNow up">\+3\.3%<\/span><\/span><span class="tag">Big buy<\/span><\/div>/);
  assert.match(text(bigBuy), /^Top gainer today · \+32\.6%0x7c1e…a93b/);
  const sell = moved(theo!);
  assert.match(sell, /<span class="act"><svg[^>]*><path d="M7 7l10 10M17 9v8H9"><\/path><\/svg>Sell<\/span><span class="actAmt" role="region" aria-label="Transaction amount" tabindex="0">\$1,100<\/span>/);
  assert.match(sell, /<span class="actAt">at \$0\.0013<\/span><\/div>/);
  assert.doesNotMatch(sell, /class="context"/);
  // View coin opens the coin's sale (R3-81's market sheet is not built): the sale dialog when mounted, else its page.
  assert.match(sell, ctaLink("View coin", "\\/presale\\/0x0+de5191a3"));
  const withDialog = at(<FeedOverlaysProvider value={{ openSale: () => undefined }}><PostCard item={theo!} nowMs={FIXTURE_NOW} /></FeedOverlaysProvider>);
  assert.match(withDialog, ctaButton("View coin"));
  // Without the moves (before they are read, or when they fail): no line, the rest unchanged.
  assert.doesNotMatch(card(luca!), /class="context"/);
  // Someone who bought through a trade post: "bought too".
  assert.match(card({ ...luca!, through: { people: 5, volume_usd: "2900.00" } }), /<b class="num">5<\/b> bought too<span class="thruAmt">/);
  // Your own trade: no call to action.
  assert.doesNotMatch(card(luca!, "lucaromano"), /Buy too/);
});

test("manually promoted Home posts disclose why they appear at the top", () => {
  assert.match(card(feedItem({ pinned: true })), /<span class="context">Pinned by Blast<\/span>/);
  assert.doesNotMatch(card(feedItem()), /Pinned by Blast/);
});
