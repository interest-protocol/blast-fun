import assert from "node:assert/strict";
import { readFileSync } from "#web/test/css-design-px.ts";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";

import { avatarSource } from "#web/components/blast-ui/avatar-source.ts";
import { SocialViewerProvider } from "#web/components/social/SignInGate.tsx";

import { FIXTURE_NOW, fixtureDetail, fixtureId, fixtureList, fixtureViewer } from "../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts";
import { PresalesList } from "./PresalesList";
import { barStage } from "@blast/core/modules/presale/presentation.ts";
import { placeMarks, raiseGeometry, raiseScale, saleChartMarks } from "./raise-geometry";
import { unpiledMarks } from "./RaiseChart";
import { BACKERS_FIRST, SaleView } from "./SaleView";

/**
 * OA-24 (the gate `design/blast-feel-preview-oa24.html`, sha256 232e34aa…3017f0a):
 * the presale list's and sale page's share of the review pass — the chart's
 * markers never pile up, a sale's bar wears its stage once it stops filling,
 * the status filter sizes to its options, section titles wrap their caption,
 * and the backers table shows ten rows, then "Show N more".
 */

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const signedIn = (node: React.ReactNode) => (
  <SocialViewerProvider callsign="kaimoreno" signedIn>
    {node}
  </SocialViewerProvider>
);
const css = readFileSync(new URL("./presales.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const spot = (x: number, y: number, r: number, rank: number, usd: number, name: string) => ({ x, y, r, rank, usd, name });

test("OA-24 chart: you first, then people you follow, then the biggest wallets; each kept only if it clears those placed", () => {
  // A big wallet, a friend and you on top of each other: only you stay.
  const pile = [spot(100, 100, 5, 2, 50_000, "whale"), spot(103, 100, 13, 1, 500, "friend"), spot(101, 101, 13, 0, 50, "you")];
  assert.deepEqual(unpiledMarks(pile, null).map((m) => m.name), ["you"]);
  // Without you, the friend beats the bigger stranger.
  assert.deepEqual(unpiledMarks(pile.slice(0, 2), null).map((m) => m.name), ["friend"]);
  // Two strangers: the bigger commit wins; at equal size the earlier one does.
  assert.deepEqual(unpiledMarks([spot(100, 100, 5, 2, 6_000, "a"), spot(104, 100, 5, 2, 9_000, "b")], null).map((m) => m.name), ["b"]);
  assert.deepEqual(unpiledMarks([spot(100, 100, 5, 2, 6_000, "a"), spot(104, 100, 5, 2, 6_000, "b")], null).map((m) => m.name), ["a"]);
  // "Clears" is the two radii plus 4: 5 + 5 + 4 = 14 apart is kept, 13.9 is not.
  assert.equal(unpiledMarks([spot(0, 0, 5, 2, 1, "a"), spot(14, 0, 5, 2, 1, "b")], null).length, 2);
  assert.equal(unpiledMarks([spot(0, 0, 5, 2, 1, "a"), spot(13.9, 0, 5, 2, 1, "b")], null).length, 1);
  // The "now" dot (radius 6) is placed first while the sale is open: even your marker gives way to it.
  assert.deepEqual(unpiledMarks([spot(10, 0, 13, 0, 1, "you")], { x: 0, y: 0 }), []);
  assert.deepEqual(unpiledMarks([spot(23, 0, 13, 0, 1, "you")], { x: 0, y: 0 }).map((m) => m.name), ["you"]);
  // What is kept comes back in time order, not priority order.
  const spread = [spot(0, 0, 5, 2, 9_000, "first"), spot(100, 0, 13, 0, 10, "second"), spot(200, 0, 13, 1, 10, "third")];
  assert.deepEqual(unpiledMarks(spread, null).map((m) => m.name), ["first", "second", "third"]);
});

test("OA-24 chart: on the sale page no two drawn markers overlap, and none sits on the now dot", () => {
  const mrdn = fixtureDetail("mrdn");
  // OA-28 M4: the chart is recharts, drawn in the browser only; the server writes its empty 220 px box (no inline style).
  const html = renderToStaticMarkup(signedIn(<SaleView detail={mrdn} nowMs={FIXTURE_NOW} viewerEntry={fixtureViewer()[fixtureId("mrdn")]} />));
  assert.match(html, /<div class="[^"]*chartBox[^"]*" id="chartBox"><\/div>/);
  // The markers it draws: the page's own picks (mine, following, big; Thesis off), placed on the line at the gate's width.
  const marks = saleChartMarks({
    detail: mrdn,
    viewerEntry: fixtureViewer()[fixtureId("mrdn")] ?? null,
    overlays: { mine: true, following: true, big: true, thesis: false },
    me: null,
    viewerCallsign: "kaimoreno",
  });
  const geometry = raiseGeometry(mrdn, FIXTURE_NOW);
  const drawn = placeMarks(geometry, mrdn.raise.points, 682, marks.map((mark) => ({ mark, r: avatarSource(mark.person?.avatar_url ?? null) ? 13 : 5 })));
  assert.ok(drawn.length >= 2, `markers drawn: ${drawn.length}`);
  assert.ok(geometry.now, "the open sale draws its now dot");
  const scale = raiseScale(geometry, 682);
  const placed = [{ x: scale.x(geometry.now.t), y: scale.y(geometry.now.v), r: 6 }, ...drawn];
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      const [a, b] = [placed[i]!, placed[j]!];
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= a.r + b.r + 4, `markers ${i} and ${j} overlap`);
    }
  }
});

test("OA-24 bars: a sale's bar wears its stage once it stops filling, on the rows and the sale page's main card", () => {
  assert.deepEqual((["pending", "open", "closed", "funded", "trading", "cancelled"] as const).map(barStage), [null, null, null, "funded", "trading", "cancelled"]);
  const ended = renderToStaticMarkup(signedIn(<PresalesList initial={fixtureList("ended", "recent")} layout="list" nowMs={FIXTURE_NOW} sort="recent" status="ended" view="list" />));
  const rows = [...ended.matchAll(/<a\b[^>]*data-list-row="[^"]+"[^>]*>(.*?)<\/a>/gs)].map((match) => {
    const status = /class="status (?:status )?([a-z]+)/.exec(match[1]!)?.[1];
    const stage = /data-stage="([a-z]+)"/.exec(match[1]!)?.[1];
    return `${status}:${stage ?? "-"}`;
  });
  assert.ok(rows.length >= 3, rows.join(" "));
  for (const row of rows) {
    const [status, stage] = row.split(":");
    assert.equal(stage, status, row);
  }
  const live = renderToStaticMarkup(signedIn(<PresalesList initial={fixtureList("live", "ending")} layout="list" nowMs={FIXTURE_NOW} sort="ending" status="live" view="list" />));
  assert.doesNotMatch(live, /data-stage=/, "a filling bar keeps the pink fill");
  for (const [key, stage] of [["cblt", "funded"], ["kstl", "trading"], ["hlcn", "cancelled"], ["mrdn", null]] as const) {
    const html = renderToStaticMarkup(signedIn(<SaleView detail={fixtureDetail(key)} nowMs={FIXTURE_NOW} viewerEntry={null} />));
    const dom = new JSDOM(html);
    try {
      const progress = dom.window.document.querySelector('[role="progressbar"][aria-label="Committed toward target"]');
      assert.ok(progress);
      assert.equal(progress.getAttribute("data-stage"), stage);
      assert.ok(progress.getAttribute("aria-valuetext"));
    } finally {
      dom.window.close();
    }
  }
});

test("OA-24 backers: ten rows, then \"Show 15 more\" (quiet, small) before the table's note", () => {
  const mrdn = fixtureDetail("mrdn");
  const html = renderToStaticMarkup(signedIn(<SaleView detail={mrdn} nowMs={FIXTURE_NOW} viewerEntry={fixtureViewer()[fixtureId("mrdn")]} />));
  const body = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>"));
  assert.equal(body.match(/<tr>/g)?.length, BACKERS_FIRST);
  assert.equal(BACKERS_FIRST, 10);
  const more = /<\/table><\/div><button class="([^"]+)" type="button">Show 15 more<\/button><p class="[^"]*tbl-note[^"]*">The 25 largest of 1,012 backers<\/p>/.exec(html);
  assert.ok(more, "the button sits between the table and its note");
  assert.deepEqual([...new Set(more[1]!.split(" "))], ["btn", "btn-quiet", "btn-sm", "bk-more"]);
  assert.match(text(html), /The 25 largest of 1,012 backers/);
  // Ten rows or fewer: no button.
  const few = renderToStaticMarkup(signedIn(<SaleView detail={{ ...mrdn, backers: { ...mrdn.backers, top: mrdn.backers.top.slice(0, 10) } }} nowMs={FIXTURE_NOW} viewerEntry={null} />));
  assert.doesNotMatch(few, /bk-more|Show \d+ more/);
  assert.match(css, /:global\(\[data-blast-ui\]\) \.bk-more \{ margin-top: 10px; \}/);
});

test("OA-24 layout: view navigation stays in one row, and section titles wrap a long caption under a one-line title", () => {
  assert.match(css, /\.presale-views \{[^}]*grid-auto-flow: column;[^}]*overflow-x: auto;/);
  assert.match(css, /:global\(\[data-blast-ui\]\) \.sec-title \{ flex-wrap: wrap; row-gap: 4px; \}\s*:global\(\[data-blast-ui\]\) \.sec-title h3 \{ white-space: nowrap; \}/);
  // The Raise title's overlays keep their own 10px row gap on phones (a more specific rule).
  assert.match(css, /\.sec-title:has\(> \.overlays\) \{ flex-wrap: wrap; row-gap: 10px; \}/);
  // Shared tabs precede the content panel and preserve section title rules.
  const list = renderToStaticMarkup(signedIn(<PresalesList initial={fixtureList("live", "ending")} nowMs={FIXTURE_NOW} sort="ending" status="live" view="list" />));
  assert.match(list, /role="tablist" aria-label="Presale views"/);
});

test("layout (#586): the fundraise and Momentum cards use two columns when narrow", () => {
  assert.match(css, /:global\(\[data-blast-ui\]\) :is\(\.sale-raise, \.sale-card:has\(> \.mtiles\)\) \{ container: tiles \/ inline-size; \}/);
  assert.match(css, /@container tiles \(max-width: 600px\) \{\s*:global\(\[data-blast-ui\]\) :is\(\.sale-tiles, \.mtiles\) \{ grid-auto-flow: row; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}\s*\}/);
});
