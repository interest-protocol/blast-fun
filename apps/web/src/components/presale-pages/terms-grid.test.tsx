import assert from "node:assert/strict";
import { readFileSync } from "#web/test/css-design-px.ts";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { SocialViewerProvider } from "#web/components/social/SignInGate.tsx";
import type { SocialPresaleDetail } from "@blast/core/modules/social/contracts/presales.ts";

import { FIXTURE_NOW, fixtureDetail } from "../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts";
import { SaleView } from "./SaleView";

/**
 * R3-90 as the Sale board (2026-10-27) draws it: one 2 × 2 grid —
 * Tokenomics beside Where the money goes, Rules beside Buyer vesting — then
 * the Terms card (the raise, the launch price, the team's vesting); one
 * column at ≤760 px.
 */

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const render = (detail: SocialPresaleDetail) => renderToStaticMarkup(
  <SocialViewerProvider callsign="kaimoreno" signedIn>
    <SaleView detail={detail} nowMs={FIXTURE_NOW} viewerEntry={null} />
  </SocialViewerProvider>,
);

/** The terms grid's markup: from its opening tag to the end of the page's sections. */
function grid(html: string): string {
  const start = html.search(/<div class="[^"]*\bsale-grid\b[^"]*">/);
  assert.ok(start >= 0, "the page draws one terms grid");
  return html.slice(start);
}

/** Each card of the grid (up to the Terms card that follows it): its heading and its rows (label → value). */
function cards(html: string) {
  const markup = grid(html);
  const end = markup.search(/<h2 id="terms-/);
  return (end < 0 ? markup : markup.slice(0, end)).split(/<section /).slice(1).map((part) => ({
    title: part.match(/<h2 id="[^"]+">([^<]+)<\/h2>/)?.[1],
    rows: [...part.matchAll(/<div><dt>([^<]+)<\/dt><dd[^>]*>([\s\S]*?)<\/dd><\/div>/g)].map(([, label, value]) => `${label}: ${text(value).trim()}`),
  })).filter(({ title }) => title);
}

/** The Terms card's rows. */
function termsRows(html: string): string[] {
  const card = html.slice(html.search(/<h2 id="terms-/));
  return [...card.slice(0, card.indexOf("</section>")).matchAll(/<div><dt>([^<]+)<\/dt><dd[^>]*>([\s\S]*?)<\/dd><\/div>/g)].map(([, label, value]) => `${label}: ${text(value).trim()}`);
}

test("R3-90-AC-1 (the Sale board): Tokenomics beside Where the money goes, Rules beside Buyer vesting, then Terms", () => {
  const html = render(fixtureDetail("mrdn"));
  assert.equal(html.match(/<div class="[^"]*\bsale-grid\b[^"]*">/g)?.length, 1);
  assert.deepEqual(cards(html).map(({ title }) => title), ["Tokenomics", "Where the money goes", "Rules", "Buyer vesting"]);
  const words = text(grid(html));
  assert.match(words, /Tokenomics Presale buyers 45% 450M MRDN Liquidity pool Locked forever 30% 300M MRDN Team Vesting 20% 200M MRDN/);
  assert.match(words, /Rules Per wallet 10 USDC to 25,000 USDC Can raise above target Tokens are split by share of commitments\. Excess payment is refunded\. Under target Full refund Withdrawals Not allowed Commit fee None/);
  assert.deepEqual(termsRows(html), ["Raise: 250,000 USDC", "Launch price: $0.000625", "Team vesting: Vests 12 mo, 3-mo cliff"]);
  assert.doesNotMatch(words, /Value at presale price|Soft cap|Hard cap|Team unlocks/, "the old footers and team card fold into Rules and Terms");
});

test("both allocation breakdowns use rows with ink and grey dots and no segmented bars", () => {
  const markup = grid(render(fixtureDetail("mrdn")));
  assert.doesNotMatch(markup, /\bsplit-bar\b/);
  const colors = [...markup.matchAll(/style="[^"]*background:\s*([^;"]+)/g)].map(([, color]) => color.trim());
  assert.ok(colors.length >= 6, "both split cards draw their parts");
  for (const color of colors) assert.match(color, /^var\(--(ink|ink-tint-[123]|faint)\)$/, color);
});

test("R3-90-AC-1: a vesting raise recipient's note is `Vests`, capitalised as the gate's", () => {
  const mrdn = fixtureDetail("mrdn");
  const terms = mrdn.terms!;
  const vesting = terms.supply.recipients[0].vesting;
  const html = render({ ...mrdn, terms: { ...terms, raise: { ...terms.raise, recipients: terms.raise.recipients.map((recipient) => ({ ...recipient, vesting })) } } });
  assert.match(text(grid(html)), /Where the money goes Of 250K USDC Liquidity pool 75% 187,500 USDC Team Vests 23% 57,500 USDC/);
});

test("R3-90-AC-1: without terms the grid holds Rules and Buyer vesting, and Terms keeps an explicit team state", () => {
  const bare = render({ ...fixtureDetail("mrdn"), terms: null });
  assert.doesNotMatch(text(bare), /Total supply/);
  assert.deepEqual(cards(bare).map(({ title }) => title), ["Rules", "Buyer vesting"]);
  assert.deepEqual(termsRows(bare), ["Raise: 250,000 USDC", "Team vesting: Vests 12 mo, 3-mo cliff"]);
  // A trading sale keeps its buyer vesting outside the folded history, so its grid is the terms and Rules.
  const kstl = fixtureDetail("kstl");
  assert.deepEqual(cards(render({ ...kstl, vesting: null, team_vesting: null })).map(({ title }) => title), ["Tokenomics", "Where the money goes", "Rules"]);
  assert.match(termsRows(render({ ...kstl, vesting: null, team_vesting: null })).join(" "), /Team vesting: No confirmed team schedule available\. Try again/);
});

test("R3-90-AC-2: `burnable` and the hard cap come from the terms read; an unknown cap says nothing over the target", () => {
  const mrdn = fixtureDetail("mrdn");
  const read = (burnable: boolean | null, hardCap: boolean | null) => {
    const html = render({ ...mrdn, presale: { ...mrdn.presale, hard_cap: null }, terms: { ...mrdn.terms!, burnable, hard_cap: hardCap } });
    const supply = text(html).match(/Total supply (.*?) Ends in/)?.[1];
    const fundingRule = cards(html).find(({ title }) => title === "Rules")!.rows.find((row) => /^(Funding cap|Can raise above target):/.test(row)) ?? null;
    return { supply, fundingRule };
  };
  assert.deepEqual(read(true, true), { supply: "1 billion · Burnable", fundingRule: "Funding cap: 250,000 USDC" });
  assert.deepEqual(read(false, false), { supply: "1 billion · Fixed", fundingRule: "Can raise above target: Tokens are split by share of commitments. Excess payment is refunded." });
  // Not read yet: the supply without the word, and no claim about the cap.
  assert.deepEqual(read(null, null), { supply: "1 billion", fundingRule: null });
});

test("the Sale board's Terms: the migration pool's trading fee from millionths, omitted without one (Aftermath, not indexed)", () => {
  const mrdn = fixtureDetail("mrdn");
  const fee = (trading_fee_ppm: number | null | undefined) => termsRows(render({ ...mrdn, terms: { ...mrdn.terms!, trading_fee_ppm } })).find((row) => row.startsWith("Trading fee")) ?? null;
  assert.equal(fee(2_500), "Trading fee: 0.25%");
  assert.equal(fee(10_000), "Trading fee: 1%");
  assert.equal(fee(500), "Trading fee: 0.05%");
  assert.deepEqual(termsRows(render({ ...mrdn, terms: { ...mrdn.terms!, trading_fee_ppm: 2_500 } })).map((row) => row.split(":")[0]), ["Raise", "Launch price", "Team vesting", "Trading fee"]);
  assert.equal(fee(null), null);
  assert.equal(fee(undefined), null);
});

test("the board grid's CSS: two stretched columns 16px apart, 48px legend rows, row hairlines, one column at ≤760 px", () => {
  const css = readFileSync(new URL("./presales.module.css", import.meta.url), "utf8");
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at >= 0, selector);
    return css.slice(at, css.indexOf("}", at));
  };
  assert.match(rule(":global([data-blast-ui]) .sale-grid"), /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); align-items: stretch; gap: 16px;/);
  assert.match(rule(":global([data-blast-ui]) .sale-card"), /display: flex; flex-direction: column; gap: 14px;.* padding: 20px 22px;/);
  assert.match(rule(":global([data-blast-ui]) .sale-card .sl"), /min-height: 48px;/);
  assert.match(rule(":global([data-blast-ui]) .sale-card .kv > div"), /box-shadow: 0 1px 0 var\(--hair\);/);
  assert.match(css, /:global\(\[data-blast-ui\]\) \.sale-grid \{ grid-template-columns: minmax\(0, 1fr\); \}/);
});

test("minute schedules keep the team row and name the cliff and end in minutes", () => {
  const sale = fixtureDetail("mrdn");
  const vesting = { start_ms: FIXTURE_NOW, cliff_end_ms: FIXTURE_NOW + 60_000, end_ms: FIXTURE_NOW + 300_000 };
  assert.deepEqual(termsRows(render({ ...sale, team_vesting: vesting })).at(-1), "Team vesting: Vests 5 min, 1-min cliff");
  // Once trading, the team's card says it in words.
  const html = text(render({ ...fixtureDetail("kstl"), team_vesting: vesting }));
  assert.match(html, /Team vesting Nothing unlocks for 1 min\. Then 20% unlocks at once/);
});

test("buyer vesting rules disclose the schedule before a claim creates a vesting object", () => {
  const detail = fixtureDetail("mrdn");
  const html = render({ ...detail, terms: { ...detail.terms!, buyer_vesting: { cliff_ms: "86400000", duration_ms: "604800000" } } });
  assert.match(text(grid(html)), /Buyer vesting Starts when each buyer claims Fully vested after 1 wk Cliff 1 d Unlocks Linear from your claim/);
});

test("buyer totals are visible outside trading history, including completed releases and unavailable terms", () => {
  const base = fixtureDetail("kstl");
  const buyer_vesting = { schedules: 251, total: "900000000000000001", claimed: "250000000000000001", remaining: "650000000000000000" };
  const html = render({ ...base, buyer_vesting, terms: { ...base.terms!, buyer_vesting: { cliff_ms: "0", duration_ms: "604800000" } } });
  const section = html.search(/>Buyer vesting<\/h2>/);
  assert.ok(section > 0 && section < html.indexOf('id="presaleHistory"'));
  assert.equal(html.match(/>Buyer vesting<\/h2>/g)?.length, 1);
  assert.match(text(html), /In buyer schedules ≈ 900.00M KSTL Released to buyers ≈ 250.00M KSTL Unclaimed ≈ 650.00M KSTL/);
  assert.match(text(html), /251 buyer schedules started/);
  const unavailable = text(render({ ...base, buyer_vesting, terms: null }));
  assert.match(unavailable, /buyer schedule is unavailable/);
  assert.match(unavailable, /Released to buyers ≈ 250.00M KSTL/);
  const disabled = text(render({ ...base, terms: { ...base.terms!, buyer_vesting: null } }));
  assert.match(disabled, /Tokens paid in full at claim/);
  assert.doesNotMatch(disabled, /No buyer vesting/);
  assert.doesNotMatch(disabled, /Released to buyers 0/);
});
