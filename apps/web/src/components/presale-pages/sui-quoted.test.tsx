import assert from "node:assert/strict";
import test from "node:test";
import { createTestQueryClient, withQueryClient } from "#web/lib/query/test-client.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import { renderToStaticMarkup } from "react-dom/server";

import { SocialViewerProvider } from "#web/components/social/SignInGate.tsx";

import { FIXTURE_NOW, FIXTURE_SUI_PRICE, fixtureDetail, fixtureList, fixtureMine, fixtureViewerEntry } from "../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts";
import { PresalesList } from "./PresalesList";
import { raisedText, targetText } from "@blast/core/modules/presale/presentation.ts";
import { raiseGeometry, raiseLabels, saleChartMarks } from "./raise-geometry";
import { SideBox } from "./SaleAside";
import { SaleView } from "./SaleView";

/**
 * R3-40 on the presales list, the sale page and its side box, over the dev
 * fixture's SUI-quoted sale (Driftwood: 99,970 of 100,000 SUI, 25 SUI
 * minimum, 5,000 SUI per wallet, Kai in with 125 SUI, SUI at $3.42). The
 * gate decides the unit of each figure: the sale's own figures — raise,
 * target, limits, prices, FDV, the money's split, the rules, the open sale's
 * "You've committed" — read in SUI from the atoms (its `qm`, `qs`,
 * `qsRaised`, `qp`, `committedTxt`); people's money — backers, theses,
 * friends, momentum, activity, chart markers, positions, refunds — reads in
 * dollars (its `usd`, `short`), `–` when there is no dollar figure. Meridian,
 * a USDC sale, reads exactly as before (AC-2's other half is every existing
 * presale-page test, unchanged).
 */

const text = (html: string) => html.replace(/<style[^>]*>[^<]*<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const signedIn = (node: React.ReactNode) => {
  const queries = createTestQueryClient();
  queries.setQueryData([...queryKeys.me.presaleViewerAll, "mine"], fixtureMine({sui: true}));
  return withQueryClient(queries, <SocialViewerProvider callsign="kaimoreno" signedIn>{node}</SocialViewerProvider>);
};

test("R3-40-AC-1/4: the catalog reads exact committed and target amounts in each sale's quote coin", () => {
  const drift = fixtureList("live", "ending", { sui: true }).presales.find((sale) => sale.symbol === "DRFT")!;
  assert.equal(raisedText(drift), "99.9K SUI");
  assert.equal(targetText(drift), "100K SUI");
  const words = text(renderToStaticMarkup(signedIn(
    <PresalesList initial={fixtureList("live", "ending", { sui: true })} layout="list" nowMs={FIXTURE_NOW} sort="ending" status="live" view="list" />,
  )));
  assert.match(words, /Driftwood Known deployer DRFT .*?99\.97% 99,970 SUI raised of a 100,000 SUI target, 99\.97 percent funded\. 99,970 of 100,000 SUI 640 backers/);
  // The USDC sale beside it names USDC: no row mixes units.
  assert.match(words, /Meridian Known deployer MRDN .*?73\.68% 184,221 USDC raised of a 250,000 USDC target, 73\.68 percent funded\. 184,221 of 250,000 USDC 1,012 backers/);
  // The gate's own lists (no `sui` option) are untouched.
  assert.ok(!fixtureList("live", "ending").presales.some((sale) => sale.symbol === "DRFT"));
});

/**
 * Luca's place in the backers table. The fixture's generated crowd around the named backers is the gate's
 * `Math.sin` walk, whose last bit differs between platforms (an arm64 Mac ranks Luca 2nd, this server 3rd), so the
 * rank is read from the same payload the page draws rather than written down.
 */
function lucaRank(detail: ReturnType<typeof fixtureDetail>): number {
  const rank = detail.backers.top.findIndex((row) => row.account?.callsign === "lucaromano") + 1;
  assert.ok(rank > 0, "Luca is among the top backers");
  return rank;
}

test("R3-40-AC-1: the sale page reads the sale's own figures in SUI (raise, target, terms, rules) and native commitments remain available without USD conversion", () => {
  const detail = fixtureDetail("drft");
  const entry = fixtureViewerEntry("drft");
  const html = renderToStaticMarkup(signedIn(<SaleView detail={detail} nowMs={FIXTURE_NOW} viewerEntry={entry} />));
  const words = text(html);
  // The main card: the raise in SUI with its target and, from the read, its dollars.
  assert.match(words, /99,970 SUI of 100,000 SUI · ≈ \$341,897 99\.97% funded/);
  // Individual commitments use their native amounts.
  assert.match(words, /People you follow Luca Romano .*? 4,000 SUI/);
  assert.match(words, new RegExp(`${lucaRank(detail)} Luca Romano Following 4,000 SUI 4\\.00% 20h`));
  // Momentum uses the quote coin too.
  assert.match(words, /Commits \d+ [0-9.,]+ SUI in New backers/);
  assert.match(words, /Average commit [0-9,.]+ SUI Median [0-9,.]+ SUI/);
  // Terms: the raise and the pool's opening price in SUI (75% of the 100,000 SUI target over the pool's 300M tokens);
  // the money's split and the rules in SUI.
  assert.match(words, /Terms Raise 100,000 SUI Launch price 0\.00025 SUI/);
  assert.match(words, /Where the money goes Of 100K SUI/);
  assert.match(words, /Liquidity pool 75% 75,000 SUI/);
  assert.match(words, /Per wallet 25 SUI to 5,000 SUI Can raise above target Tokens are split by share of commitments\. Excess payment is refunded\./);
  // The raise chart draws after hydration (OA-28 M4), so its words and heights are read from what it is given.
  const labels = raiseLabels(detail);
  assert.match(labels.label, /^Total raised over time: [0-9,.]+ SUI of 100,000 SUI$/);
  assert.equal(labels.target, "Target 100K SUI");
  const geometry = raiseGeometry(detail, FIXTURE_NOW);
  assert.equal(geometry.target, 100_000, "the target line at 100,000 SUI, not its dollars");
  assert.ok(geometry.total > 99_000 && geometry.total <= 100_000, "the line's height in SUI");
  // The chart's markers read in dollars (`usd(p.b.usd)`).
  const marks = saleChartMarks({ detail, viewerEntry: entry, overlays: { mine: true, following: true, big: true, thesis: false }, me: null, viewerCallsign: "kaimoreno" });
  assert.ok(marks.some((mark) => mark.who === "Luca" && mark.usd === 13_680), "Luca's marker at $13,680");
});

test("V-05: a tiny SUI raise fills the chart — the mainnet test sale's 0.02 of 0.02 SUI, two commits 2.6 s apart, is drawn at its height, not flat on a 1 SUI axis", () => {
  // 0x32fc…e9ea on mainnet: opened 1791509520240, ended 1791509610169, commits of 0.01 SUI at +2.8 s and +5.4 s.
  const base = fixtureDetail("drft");
  const detail = {
    ...base,
    presale: { ...base.presale, phase: "trading" as const, opened_ms: 1791509520240, start_ms: 1791509520169, end_ms: 1791509610169, target_atoms: "20000000", raised_atoms: "20000000" },
    raise: { points: [[1791509523069, "0.00", "10000000"], [1791509525689, "0.00", "20000000"]] as [number, string, string][], markers: [] },
  };
  const geometry = raiseGeometry(detail, 1791509700000);
  assert.equal(geometry.target, 0.02);
  assert.equal(geometry.total, 0.02);
  assert.ok(Math.abs(geometry.maxV - 0.0224) < 1e-12, `the axis tops at 112% of the target, not 1 SUI (was ${geometry.maxV})`);
  // With neither a target nor a raise the axis still has a height.
  assert.equal(raiseGeometry({ ...detail, presale: { ...detail.presale, target_atoms: "0" }, raise: { points: [], markers: [] } }, 1791509700000).maxV, 1);
});

test("R3-40-AC-5: with no SUI price a SUI sale's dollar figures are omitted (`–`), never guessed; its SUI figures need no price", () => {
  const detail = fixtureDetail("drft");
  const entry = fixtureViewerEntry("drft");
  assert.ok(FIXTURE_SUI_PRICE.as_of_ms === Date.UTC(2026, 9, 3, 17, 59));
  // The read answers no dollars for today's-price figures without a SUI row: the backers' and the friends'.
  const unpriced = {
    ...detail,
    quote_price: null,
    backers: { ...detail.backers, top: detail.backers.top.map((row) => ({ ...row, commitment_usd: null })) },
  };
  const unpricedEntry = { ...entry, following_total_usd: null, following: entry.following.map((row) => ({ ...row, commitment_usd: null })) };
  const words = text(renderToStaticMarkup(signedIn(<SaleView detail={unpriced} nowMs={FIXTURE_NOW} viewerEntry={unpricedEntry} />)));
  assert.match(words, /People you follow Luca Romano .*? 4,000 SUI/, "an unpriced row keeps its SUI");
  assert.match(words, new RegExp(`${lucaRank(detail)} Luca Romano Following 4,000 SUI 4\\.00% 20h`));
  assert.match(words, /99,970 SUI of 100,000 SUI/);
  // No "converted at today's price" note anywhere: the gate draws none.
  assert.doesNotMatch(renderToStaticMarkup(signedIn(<SaleView detail={detail} nowMs={FIXTURE_NOW} viewerEntry={entry} />)), /today’s SUI price/);
});

test("R3-40-AC-1: the open and refund boxes display the wallet amount in SUI", () => {
  const detail = fixtureDetail("drft");
  const entry = fixtureViewerEntry("drft");
  assert.match(text(renderToStaticMarkup(signedIn(<SideBox detail={detail} entry={entry} now={FIXTURE_NOW} />))), /You've committed 125 SUI/);
  const cancelled = { ...detail, presale: { ...detail.presale, phase: "cancelled" as const } };
  const refund = renderToStaticMarkup(signedIn(<SideBox detail={cancelled} entry={entry} now={FIXTURE_NOW} />));
  assert.match(refund, /class="coin-amount" title="SUI">125/);
  assert.match(text(refund), /Your refund 125 SUI Claim refund/);
  const unpriced = { ...entry, mine: { ...entry.mine!, commitment_usd: null } };
  assert.match(text(renderToStaticMarkup(signedIn(<SideBox detail={cancelled} entry={unpriced} now={FIXTURE_NOW} />))), /Your refund 125 SUI Claim refund/);
});

test("R3-40-AC-6: the followed backers' total of one sale is that sale's atoms, one unit", () => {
  const entry = fixtureViewerEntry("drft");
  assert.equal(entry.following_total_atoms, entry.following.reduce((sum, row) => sum + BigInt(row.commitment_atoms), 0n).toString());
});
