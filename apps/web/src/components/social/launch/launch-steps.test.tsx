import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CREATE_SUI_QUOTE_TYPE, CREATE_TEST_SUI_QUOTE_TYPE, CREATE_WAL_QUOTE_TYPE } from "@blast/core/modules/social/contracts/create.ts";
import type { LaunchRules } from "@blast/core/modules/social/launch/model.ts";
import { LAUNCH_PUBLISH_STEPS } from "@blast/core/web/contracts/launch.ts";
import type { SocialPriceHistory } from "@blast/core/web/contracts/prices.ts";
import { createTestQueryClient, withQueryClient } from "#web/lib/query/test-client.ts";

import { stepDone } from "../create/create-steps";
import { priceQuery } from "../prices/price-client";
import { useQuoteUsd } from "../prices/use-quote-usd";
import { CoinStep, CurveStep, DetailsStep } from "./LaunchForm";
import { LaunchLoadingFields } from "./LaunchLoading";
import { LOGO_GUIDE } from "../create/create-field-model";
import { LaunchAside, LaunchSheet, ReviewStep } from "./LaunchReview";
import { launchBlockedReason } from "./launch-review-model";
import { admittedLaunchDraft, compatibleLaunchPool, initialLaunchState, issuesOf, LAUNCH_STEPS, minimumQuoteTarget, stepOfIssue, type LaunchState, type LaunchStep } from "./launch-store";

const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const RULES: LaunchRules = {
  meme_decimals: [6, 9],
  quote_fee_bps: 100,
  meme_fee_bps: 50,
  protocol_meme_bps: 250,
  protocol_quote_bps: 150,
  creation_fee: "0",
  protocol_fee_share_bps: 6_500,
  pool_fee_meme_bps: 5_000,
  pool_fee_quote_bps: 1_500,
  quotes: [CREATE_SUI_QUOTE_TYPE, USDC],
  cetus_tiers: { [CREATE_SUI_QUOTE_TYPE]: [[200, 10_000]] },
  bluefin_options: { status: "ready", min_tick: -443_636, max_tick: 443_636 },
};

function ready(change: Partial<LaunchState> = {}): LaunchState {
  const base = initialLaunchState({ rules: RULES, publish: { available: true, reasons: [] } });
  return { ...base, phase: "ready", draftId: "00000000-0000-4000-8000-000000000101", version: 2, logoUrl: "https://blob.example/pip.webp", draft: { ...base.draft, name: "Pip", symbol: "PIP" }, ...change };
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const form = (state: LaunchState) => ({ state, issues: issuesOf(state), rules: RULES });

test("Coin asks for logo, name, ticker and description, and keeps supply kind, decimals and sell burn", () => {
  const html = text(renderToStaticMarkup(<CoinStep form={form(ready())} onLogo={() => undefined} />));
  for (const label of ["Name", "Ticker", "Description", "Total supply", "1,000,000,000", "Burn only", "Advanced", "9 decimals", "sell burn 0%", "Continue to curve"]) assert.match(html, new RegExp(label), label);
});

test("bonding-curve creation flags slurs before signing and keeps saved launches resumable", () => {
  const start = ready();
  const state = ready({
    reviewed: true,
    draft: { ...start.draft, name: "ＮＩＧＧ４", symbol: "PIP_KIKE", description: "A níg\u200Bgers coin", tagline: "For gooks" },
  });
  const issues = issuesOf(state);
  assert.deepEqual(issues.map(({ path }) => path), ["name", "symbol", "description", "tagline"]);
  const coin = renderToStaticMarkup(<CoinStep form={form(state)} onLogo={() => undefined} />);
  assert.match(coin, /<textarea[^>]*aria-describedby="cr-error-description"[^>]*aria-invalid="true"/);
  assert.match(coin, /id="cr-error-description" role="status">Remove the slur from the description\./);
  const review = renderToStaticMarkup(<LaunchAside placement="rail" state={{ ...state, step: "review" }} />);
  assert.match(review, /data-launch=""[^>]*disabled=""/);
  assert.deepEqual(issuesOf({ ...state, publishing: true }), []);
});

test("a published fixed-supply legacy coin describes its locked unsold tokens", () => {
  const state = ready();
  const retained = { ...state, publishing: true, draft: { ...state.draft, burnable: false } };
  const coin = text(renderToStaticMarkup(<CoinStep form={form(retained)} onLogo={() => undefined} />));
  assert.match(coin, /Fixed/);
  assert.match(coin, /Unsold curve tokens are locked forever at graduation/);
  assert.doesNotMatch(coin, /Enable automatic burning|tokens are burned/);
  const curve = renderToStaticMarkup(<CurveStep form={form(retained)} />);
  assert.match(curve, /Unsold, locked forever at graduation/);
  assert.doesNotMatch(curve, /Unsold, burned|tokens are burned/);
});

test("Curve offers every admitted coin with its venues, lets the creator choose curve and pool shares, and splits pool fees four ways", () => {
  const html = renderToStaticMarkup(<CurveStep form={form(ready())} />);
  const words = text(html);
  for (const label of ["Raise in", "SUI", "Starting liquidity", "Raise target", "Starts at", "Graduates at", "On the curve", "Liquidity pool", "Unused", "Token split", "Recipients (optional)", "Blast", "Raise split", "Pool fee", "You", "Holders", "Auto-LP", "Buyback &amp; burn", "Curve trading fees", "65%", "35%"]) {
    assert.ok(words.includes(label), label);
  }
  // The coin is a dropdown: its button names the chosen coin; the list opens on press.
  assert.match(html, /<button[^>]*aria-haspopup="menu"[^>]*aria-label="Raise in SUI\. Change"[^>]*data-f="quote_type"/);
  assert.equal(words.match(/FDV/g)?.length, 3, "The pool opens with less supply after the burn");
  assert.match(words, /Pool opening/);
  const fixed = ready();
  const fixedWords = text(renderToStaticMarkup(<CurveStep form={form({ ...fixed, draft: { ...fixed.draft, burnable: false } })} />));
  assert.equal(fixedWords.match(/FDV/g)?.length, 2, "The graduation and pool FDVs match for fixed supply");
  assert.doesNotMatch(fixedWords, /Pool opening/);
  // A small target still labels the curve valuation accurately; allocations stay as set.
  const smallTarget = ready();
  const smallWords = text(renderToStaticMarkup(<CurveStep form={form({ ...smallTarget, draft: { ...smallTarget.draft, graduation_target: 10 } })} />));
  assert.ok(smallWords.includes("Graduates at"));
  assert.ok(smallWords.includes("Curve 78.23%, pool 19.27%"));
  // No control picks a share of the raise, and no opening round is offered.
  assert.doesNotMatch(words, /Opening round/);
  assert.doesNotMatch(html, /aria-label="[^"]*SUI share"/);
});

test("new SUI curve forms require a 2,000 SUI target and a 70% pool share", () => {
  const rules = { ...RULES, protocol_quote_bps: 3_000 };
  const state = ready({ rules, reviewed: true });
  const minimum = { ...state, draft: { ...state.draft, graduation_target: 2_000 } };
  assert.deepEqual(issuesOf(minimum), []);
  assert.deepEqual(issuesOf({ ...minimum, draft: { ...minimum.draft, graduation_target: 0 } }), [
    { section: "curve", path: "graduation_target", message: "Set the raise target" },
  ]);

  const lowRules = { ...rules, protocol_quote_bps: 3_001 };
  const below = { ...minimum, rules: lowRules, draft: { ...minimum.draft, graduation_target: 1_999.9999 } };
  const curve = text(renderToStaticMarkup(<CurveStep form={{ ...form(below), rules: lowRules }} />));
  assert.match(curve, /Set a raise target of at least 2,000 SUI/);
  assert.match(curve, /At least 70% of the SUI raise must go to the pool/);
  assert.equal(launchBlockedReason(below, issuesOf(below)), "Fix the curve to launch.");
  assert.deepEqual(issuesOf({ ...below, publishing: true }), []);
});

test("a WAL launch requires the current SUI-equivalent target and the same pool share", () => {
  const rules = { ...RULES, quotes: [...RULES.quotes, CREATE_WAL_QUOTE_TYPE], protocol_quote_bps: 3_000 };
  const state = ready({ rules, reviewed: true, step: "curve" });
  const quote_type = CREATE_WAL_QUOTE_TYPE;
  const draft = { ...state.draft, ...compatibleLaunchPool(state.draft, rules, quote_type), quote_type, graduation_target: 3_142.86 };
  const amount = minimumQuoteTarget("1.1", "0.7");
  assert.strictEqual(amount, 3_142.86);
  const minimum = { ...state, draft, raiseMinimum: { quoteType: quote_type, amount } };
  assert.equal(minimumQuoteTarget("1.00001", "1"), 2_000.02);
  assert.equal(minimumQuoteTarget("3.42", "1"), 6_840);
  assert.equal(minimumQuoteTarget("1.1", "0"), null);
  assert.deepEqual(issuesOf(minimum), []);

  const below = { ...minimum, rules: { ...rules, protocol_quote_bps: 3_001 }, draft: { ...draft, graduation_target: 3_142.85 } };
  const curve = text(renderToStaticMarkup(<CurveStep form={{ ...form(below), rules: below.rules }} />));
  assert.match(curve, /Set a raise target of at least 3,142\.86 WAL/);
  assert.match(curve, /At least 70% of the WAL raise must go to the pool/);
  assert.deepEqual(issuesOf({ ...below, publishing: true }), []);

  const unavailable = { ...minimum, raiseMinimum: null };
  assert.match(text(renderToStaticMarkup(<CurveStep form={{ ...form(unavailable), rules }} />)), /Wait for prices or choose another coin/);
  const oldPrice = { ...minimum, raiseMinimum: { quoteType: USDC, amount: 1 } };
  const review = renderToStaticMarkup(<LaunchAside placement="rail" state={{ ...oldPrice, step: "review" }} />);
  assert.match(review, /data-launch=""[^>]*disabled=""/);
});

test("launch conversion can use the indexed USDC price without changing display prices", () => {
  const client = createTestQueryClient({ queries: { gcTime: Infinity } });
  client.setQueryData<SocialPriceHistory>(priceQuery({ kind: "coin", id: USDC, window: "1h" }).queryKey, {
    presale_id: null, coin_type: USDC, tier: "5m", from_ms: 0, points: [],
    price_usd: "0.99", price_as_of_ms: Date.now(), price_24h_usd: null,
    change_24h_bps: null, day_open_usd: null, day_open_ms: null,
  });
  function RaiseMinimum() {
    const quoteUsd = useQuoteUsd(USDC, { marketRate: true });
    const displayUsd = useQuoteUsd(USDC);
    return <>{minimumQuoteTarget("1", quoteUsd)} / {displayUsd}</>;
  }
  assert.equal(text(renderToStaticMarkup(withQueryClient(client, <RaiseMinimum />))), "2020.21 / 1");
});

test("Curve stays open and the rest fold into rows that show their values; a shown error opens its row", () => {
  const rowsOf = (html: string) => [...html.matchAll(/<section[^>]*data-sec="([a-z]+)"[^>]*><h2[^>]*><button[^>]*aria-expanded="(true|false)"[^>]*>.*?id="lc-[a-z]+-title">([^<]+)<\/span> <span[^>]*>· ([^<]+)<\/span>/g)].map(([, id, open, title, value]) => `${id} ${open === "true" ? "open" : "folded"}: ${title} · ${value}`);
  const html = renderToStaticMarkup(<CurveStep form={form(ready())} />);
  assert.match(html, /<h2 id="lc-curve-title">Curve<\/h2>/);
  assert.deepEqual(rowsOf(html), [
    "pool folded: Pool · Cetus, 1% fee",
    "trading folded: Curve trading fees · You get 35%",
    "split folded: Token split · Curve 78.23%, pool 19.27%",
    "raise folded: Raise split · Pool 98.5%, Blast 1.5%",
    "fees folded: Pool fees · You 50%, holders 50%",
  ]);
  for (const title of ["Pool", "Curve trading fees", "Token split", "Raise split", "Pool fees"]) assert.ok(title.split(" ").length <= 6);
  const state = ready();
  const erring = renderToStaticMarkup(<CurveStep form={form({ ...state, reviewed: true, draft: { ...state.draft, pool_bps: 0 } })} />);
  assert.deepEqual(rowsOf(erring).filter((row) => row.includes(" open:")).map((row) => row.split(" ")[0]), ["split"], "only the row with the error opens");
});

test("a coin no venue pairs with leaves its venues disabled with the reason", () => {
  const state = ready();
  const html = text(renderToStaticMarkup(<CurveStep form={form({ ...state, reviewed: true, draft: { ...state.draft, quote_type: USDC } })} />));
  assert.match(html, /Cetus does not support USDC for new launches/);
});

test("Details carries the presale's links", () => {
  const html = text(renderToStaticMarkup(<DetailsStep form={form(ready())} onCover={() => undefined} onCoverRemove={() => undefined} />));
  for (const label of ["Cover", "Short description", "Links"]) assert.match(html, new RegExp(label), label);
});

test("Review lists every group and Launch waits for a finished draft", () => {
  const done = ready();
  assert.deepEqual(issuesOf(done), []);
  const review = text(renderToStaticMarkup(<ReviewStep state={{ ...done, step: "review" }} />));
  for (const group of ["Coin", "Curve", "Splits", "Pool", "Details"]) assert.match(review, new RegExp(group), group);
  // Each group is one folded row with its short value; a finished draft opens none, so Review and Launch fit one phone screen.
  const html = renderToStaticMarkup(<ReviewStep state={{ ...done, step: "review" }} />);
  assert.deepEqual([...html.matchAll(/<span id="lc-rv-[a-z]+-title">([^<]+)<\/span> <span class="[^"]*cr-disclosure-note[^"]*">· ([^<]+)<\/span>/g)].map((match) => `${match[1]} · ${match[2]}`), [
    `Coin · ${done.draft.burnable ? "Burn only" : "Fixed supply"}, 9 decimals`,
    `Curve · Raise ${done.draft.graduation_target.toLocaleString("en-US")} SUI`,
    `Splits · Curve ${done.draft.curve_bps / 100}%, pool ${done.draft.pool_bps / 100}%`,
    `Pool · ${done.draft.venue === "cetus" ? "Cetus" : "Bluefin"}, you get ${done.draft.creator_fee_bps / 100}% of fees`,
    "Details · None added",
    "First buy · None",
    "Signatures · 3 in your wallet",
  ]);
  assert.equal(html.match(/aria-expanded="true"/g)?.length ?? 0, 0);
  // Review opens no group by itself: a wrong value is named in its row, in the attention ink, and a press opens it.
  const badSite = renderToStaticMarkup(<ReviewStep state={{ ...done, step: "review", draft: { ...done.draft, site: "not a website" } }} />);
  assert.equal(badSite.match(/aria-expanded="true"/g)?.length ?? 0, 0);
  assert.match(badSite, /<span id="lc-rv-details-title">Details<\/span> <span class="[^"]*cr-disclosure-note[^"]*">· <span class="[^"]*cr-fold-attn[^"]*">Website isn&#x27;t a web address<\/span>/);
  // The first buy is a folded row too: its amount when set, closed until pressed; a wrong amount is named in the row in the attention ink.
  const bought = renderToStaticMarkup(<ReviewStep state={{ ...done, step: "review", draft: { ...done.draft, first_buy: 100 } }} />);
  assert.match(bought, /<span id="lc-rv-buy-title">First buy<\/span> <span class="[^"]*cr-disclosure-note[^"]*">· 100\u00a0SUI<\/span>/);
  assert.equal(bought.match(/aria-expanded="true"/g)?.length ?? 0, 0);
  const tiny = renderToStaticMarkup(<ReviewStep state={{ ...done, step: "review", draft: { ...done.draft, first_buy: -1 } }} />);
  assert.match(tiny, /<span id="lc-rv-buy-title">First buy<\/span> <span class="[^"]*cr-disclosure-note[^"]*">· <span class="[^"]*cr-fold-attn[^"]*">The first buy can&#x27;t be negative<\/span>/);
  // No estimate line repeats the money sentence ("≈ 9.5M PIP").
  assert.doesNotMatch(bought, /≈/);
  // A value with a ticker is one inline run: one space before the ticker, never the cell's flex gap.
  assert.match(html, /<dt>Blast’s share<\/dt><dd class="num"><span>15% of SUI · 50% of <span class="ticker">PIP<\/span><\/span><\/dd>/);
  assert.match(html, /<dt>Curve trading fee<\/dt><dd class="num"><span>You get [^<]+<\/span><span class="[^"]*cr-detail[^"]*">[^<]+ of <span class="ticker">PIP<\/span><\/span><\/dd>/);
  for (const cell of html.match(/<dd[^>]*>.*?<\/dd>/g)!.filter((dd) => dd.includes('class="ticker"'))) assert.match(cell, /^<dd[^>]*>(?:<span[^>]*>(?:[^<]|<span class="ticker">[^<]*<\/span>)*<\/span>)+<\/dd>$/, cell);
  // The signatures fold names the coin by its ticker, and says who pays the network fees.
  const signed = renderToStaticMarkup(<ReviewStep state={{ ...done, step: "review", networkFees: "blast" }} />);
  assert.match(signed, /<span>Network fees<\/span><b>Paid by Blast<\/b>/);
  // No row holds more than three numbers: the pool fees are your share, then Blast's, then the others.
  assert.match(text(html), /Pool fees You get \d+(?:\.\d+)?% of pool fees After Blast’s share Blast’s share 15% of SUI · 50% of PIP Other shares Holders \d+(?:\.\d+)?%/);
  const aside = renderToStaticMarkup(<LaunchAside placement="rail" state={{ ...done, step: "review" }} />);
  assert.doesNotMatch(text(aside), /Three signatures/);
  // The rail card holds the money sentence and Launch only: the first buy is Review's row, and no estimate repeats the sentence.
  assert.doesNotMatch(aside, /First buy|≈|<input/);
  const buyAside = renderToStaticMarkup(<LaunchAside placement="rail" state={{ ...done, step: "review", draft: { ...done.draft, first_buy: 100 } }} />);
  // Each amount stays with its unit or ticker: a no-break space joins them, so they never wrap apart.
  assert.match(buyAside, /You pay 100\u00a0SUI and get at least [\d.,]+[KMB]?\u00a0<span class="ticker">PIP<\/span>\. Launching locks/);
  assert.doesNotMatch(buyAside, /≈/);
  // The one-way door ends the money sentence above Launch; no separate warning card.
  assert.equal(text(aside).match(/Launching locks the curve and pool\./g)?.length, 1);
  assert.doesNotMatch(aside, /cr-warn|can’t change/);
  // The signatures name the coin by its ticker, as presale Publish does (`Publish $MRDN`).
  const signs = [...html.slice(html.indexOf("cr-signs")).matchAll(/<span class="[^"]*\bt\b[^"]*"><b>(.*?)<\/b>/g)].map((match) => match[1]!.replace(/<[^>]+>/g, ""));
  assert.deepEqual(signs, [`Create \$${done.draft.symbol}`, `Register \$${done.draft.symbol}`, "Start trading"]);
  assert.match(aside, /<button[^>]*>Launch<\/button>/);
  const unfinished = renderToStaticMarkup(<LaunchAside placement="rail" state={{ ...done, step: "review", logoUrl: null }} />);
  assert.match(unfinished, /<button[^>]*disabled=""[^>]*>Launch</);
});

test("Launch shows one primary action and one reason line per width: the rail card wide, the action row below the breakpoint", () => {
  const primary = (html: string) => html.match(/data-ui-variant="primary"/g)?.length ?? 0;
  const blocked = { ...ready(), step: "review" as const, logoUrl: null };
  const rail = renderToStaticMarkup(<LaunchAside placement="rail" state={blocked} />);
  const page = renderToStaticMarkup(<LaunchAside placement="page" state={blocked} />);
  // On the page Review has no card (the first buy is a fold row), so the placement is the action row alone (hidden at >= 1220px).
  const [, row = ""] = page.match(/^(<div class="[^"]*cr-aside-action[^"]*">[\s\S]*<\/div>)$/) ?? [];
  assert.ok(row, "the page placement on Review is the action row alone");
  assert.doesNotMatch(page, /cr-aside-inline/);
  for (const [html, count] of [[rail, 1], [row, 1]] as const) {
    assert.equal(primary(html), count);
    assert.equal(html.match(/class="[^"]*cr-note[^"]*" id="[^"]+-reason"/g)?.length ?? 0, count);
  }
  const symbol = "ABCDEFGHIJKLMNOPQRSTUVWXYZ_12345";
  const review = renderToStaticMarkup(<ReviewStep state={{ ...ready(), step: "review", draft: { ...ready().draft, symbol } }} />);
  // The name and ticker are the hero, not a row as well; the ticker breaks only when it cannot fit, never cut or hidden in a title.
  assert.doesNotMatch(review, /Name and ticker/);
  assert.match(review, new RegExp(`<b>Pip</b><span><span class="ticker">\\$${symbol}</span> · Bonding</span>`));
  assert.doesNotMatch(review, /cr-one-line|title=/);
});

test("Review identifies every token and pool-fee recipient by wallet", () => {
  const state = ready();
  const tokenAddress = `0x${"1".repeat(64)}`;
  const feeAddress = `0x${"2".repeat(64)}`;
  const draft = { ...state.draft, recipients: [{ label: "Treasury", address: tokenAddress, bps: 500 }], fee_recipients: [{ label: "Operations", address: feeAddress, bps: 500 }] };
  const html = text(renderToStaticMarkup(<ReviewStep state={{ ...state, draft }} />));
  // Each wallet once, short, with its share.
  assert.match(html, /1\. Treasury wallet 0x1111…1111 · 5%/);
  assert.match(html, /1\. Operations wallet 0x2222…2222 · 5%/);
  assert.doesNotMatch(html, new RegExp(`${tokenAddress}|${feeAddress}`));
});

test("before Review the right column is the preview alone, and the launch sheet marks only the step after the current one Next", () => {
  const state = ready();
  const invalid = { ...state, step: "details" as const, reviewed: true, draft: { ...state.draft, site: "not a website" } };
  const aside = text(renderToStaticMarkup(<LaunchAside placement="rail" state={invalid} />));
  assert.match(aside, /How it appears/);
  assert.doesNotMatch(aside, /Complete required fields|Ready to launch|Graduation|Then trades/, "no readiness card and no graduation figures beside the form");
  // KA-1: a draft that could not load has no preview; its error card stands in for the step, as presale.
  for (const placement of ["rail", "page"] as const) assert.equal(renderToStaticMarkup(<LaunchAside placement={placement} state={{ ...state, phase: "error" }} />), "");
  // The invalid detail stays actionable on its own step.
  assert.match(text(renderToStaticMarkup(<DetailsStep form={form(invalid)} onCover={() => undefined} onCoverRemove={() => undefined} />)), /website|URL|https/i);
  const sheet = renderToStaticMarkup(<LaunchSheet onLaunch={() => undefined} state={{ ...state, sheetOpen: true, publishStep: LAUNCH_PUBLISH_STEPS[0]! }} />);
  assert.deepEqual([...sheet.matchAll(/<small>([^<]*)<\/small>/g)].map((match) => match[1]), ["In progress", "Next", ...LAUNCH_PUBLISH_STEPS.slice(2).map(() => "")]);
  assert.doesNotMatch(sheet, /Up next/);
  // The presale's coin scene plays through every step: its pose follows the step, and a pause stills it.
  assert.match(sheet, /class="[^"]*cr-launch[^"]*" data-paused="false" data-published="false" data-stage="0"/);
  assert.match(sheet, /cr-launch-scene/);
  // The title names the coin by its ticker, in the shared class.
  assert.match(sheet, /id="lc-sheet-title"[^>]*>Launching <span class="ticker">\$PIP<\/span><\/h2>/);
  // Open before the first step reports: the wallet is opening and step 1 is already in progress, never an idle sheet (MA-8).
  const opening = renderToStaticMarkup(<LaunchSheet onLaunch={() => undefined} state={{ ...state, sheetOpen: true, publishStep: null }} />);
  assert.match(opening, /Opening your wallet…/);
  assert.deepEqual([...opening.matchAll(/<small>([^<]*)<\/small>/g)].map((match) => match[1]), ["In progress", "Next", ""]);
  // A paused launch: the error with its code on its own line, and no second line saying what was saved.
  const paused = renderToStaticMarkup(<LaunchSheet onLaunch={() => undefined} state={{ ...state, sheetOpen: true, publishStep: LAUNCH_PUBLISH_STEPS[1]!, publishError: "Launching could not finish. Code: launch_failed." }} />);
  assert.match(paused, /data-paused="true" data-published="false" data-stage="1"/);
  assert.match(paused, /role="alert">Launching could not finish\.<span class="err-code"> Code: launch_failed\.<\/span><\/p>/);
  // Said once: one muted line under the steps, not in the error.
  assert.equal(paused.match(/saved\b/g)?.length, 1);
  assert.match(paused, /<p class="[^"]*snote[^"]*">Your progress is saved\.<\/p>/);
  // The sheet's steps read as the review list's three signatures.
  const steps = [...sheet.matchAll(/<li [^>]*><span aria-hidden="true"[^>]*>[^<]*<\/span><span>(.*?)<\/span><small>/g)].map((match) => match[1]!.replace(/<[^>]+>/g, ""));
  assert.deepEqual(steps, state.draft.symbol ? [`Create $${state.draft.symbol}`, `Register $${state.draft.symbol}`, "Start trading"] : ["Create the coin", "Register the coin", "Start trading"]);
});

test("the pool share is editable and recipients reduce the unused share", () => {
  const state = ready();
  const draft = { ...state.draft, curve_bps: 5_000, pool_bps: 2_000, recipients: [{ label: "Treasury", address: `0x${"1".repeat(64)}`, bps: 1_000 }] };
  const html = renderToStaticMarkup(<CurveStep form={form({ ...state, draft })} />);
  assert.match(html, /aria-label="In the liquidity pool: exact share of supply"/);
  assert.match(text(html), /Unused 17.5%/);
  assert.match(text(html), /Locked forever at graduation/);
  assert.match(text(html), /Up to 15/);
  assert.match(text(html), /below the curve/);
  assert.doesNotMatch(text(html), /Give recipients|To allocate|Opens at the curve/);
  const review = text(renderToStaticMarkup(<ReviewStep state={{ ...state, draft }} />));
  assert.match(review, /50% curve · 20% pool · 30% recipients, Blast and unused/);
  // A fee share reads as set: Blast's 2.5% is never rounded to 3%.
  const exact = text(renderToStaticMarkup(<ReviewStep state={{ ...state, draft: { ...state.draft, curve_bps: 8_000, pool_bps: 1_750, recipients: [] } }} />));
  assert.match(exact, /80% curve · 17\.5% pool · 2\.5% Blast/);
  assert.doesNotMatch(exact, /3% Blast|18% pool/);
});

test("no screen names a burn address: unused and unsold supply is said in words", () => {
  for (const burnable of [true, false]) {
    const state = ready();
    const draft = { ...state.draft, burnable, recipients: [{ label: "Treasury", address: `0x${"1".repeat(64)}`, bps: 500 }] };
    const html = [
      renderToStaticMarkup(<CoinStep form={form({ ...state, draft })} onLogo={() => undefined} />),
      renderToStaticMarkup(<CurveStep form={form({ ...state, draft })} />),
      renderToStaticMarkup(<ReviewStep state={{ ...state, draft }} />),
    ].join("");
    assert.doesNotMatch(text(html), /0xdead|0x0\b/i);
  }
});

test("a step is checked only once it is finished, and a disabled Launch says only what is missing", () => {
  const done = ready();
  const state = { ...done, logoUrl: null, step: "review" as const, draft: { ...done.draft, name: "" } };
  const issues = issuesOf(state);
  const open = (step: LaunchStep) => issues.some((issue) => stepOfIssue(issue) === step);
  assert.deepEqual(LAUNCH_STEPS.filter((step) => stepDone(LAUNCH_STEPS, step, state.step, open)), ["curve", "details"]);
  assert.equal(launchBlockedReason(state, issues), "Add a name and a logo to launch.");
  const badSite = { ...done, step: "review" as const, draft: { ...done.draft, site: "not a website" } };
  assert.equal(launchBlockedReason(badSite, issuesOf(badSite)), "Fix the details to launch.");
  const html = renderToStaticMarkup(<LaunchAside placement="rail" state={state} />);
  assert.match(html, /aria-describedby="[^"]+-reason"[^>]*disabled=""/);
  assert.match(html, /<p class="[^"]*cr-note[^"]*" id="[^"]+-reason">Add a name and a logo to launch\.<\/p>/);
});


test("new drafts select a supported venue/fee for a Bluefin-only quote", () => {
  const rules = { ...RULES, quotes: [CREATE_TEST_SUI_QUOTE_TYPE] };
  const state = initialLaunchState({ rules, publish: { available: true, reasons: [] } });
  assert.equal(state.draft.venue, "bluefin");
  assert.ok(!issuesOf(state).some((issue) => ["venue", "pool_fee", "quote_type"].includes(issue.path)));
  const preserved = compatibleLaunchPool(state.draft, rules, CREATE_TEST_SUI_QUOTE_TYPE);
  assert.equal(preserved.venue, "bluefin");
  assert.equal(preserved.pool_fee, state.draft.pool_fee);
  const unsupported = compatibleLaunchPool({ ...state.draft, venue: "cetus", pool_fee: 12345 }, rules, CREATE_TEST_SUI_QUOTE_TYPE);
  assert.equal(unsupported.venue, "bluefin");
  assert.notEqual(unsupported.pool_fee, 12345);
});

test("a saved TSUI draft opens on SUI once TSUI is no longer admitted; other coins are left alone", () => {
  const { draft } = initialLaunchState({ rules: RULES, publish: { available: true, reasons: [] } });
  const stale = { ...draft, quote_type: CREATE_TEST_SUI_QUOTE_TYPE, venue: "bluefin" as const };
  const opened = admittedLaunchDraft(stale, RULES);
  assert.equal(opened.quote_type, CREATE_SUI_QUOTE_TYPE);
  assert.ok(!issuesOf({ ...ready(), draft: opened }).some((issue) => ["venue", "pool_fee", "quote_type"].includes(issue.path)));
  assert.equal(admittedLaunchDraft(draft, RULES), draft);
  assert.equal(admittedLaunchDraft(stale, { ...RULES, quotes: [] }), stale);
  const usdc = { ...draft, quote_type: USDC };
  assert.equal(admittedLaunchDraft(usdc, { ...RULES, quotes: [CREATE_SUI_QUOTE_TYPE] }), usdc);
});

test("an incomplete launch never claims readiness or renders an empty identity", () => {
  const state = { ...initialLaunchState({ rules: RULES, publish: { available: true, reasons: [] } }), phase: "ready" as const, step: "curve" as const };
  const aside = text(renderToStaticMarkup(<LaunchAside placement="rail" state={state} />));
  assert.match(aside, /— — Bonding/, "no sample name or ticker rendered as data: the muted dash for each");
  assert.doesNotMatch(aside, /Your coin/);
  assert.doesNotMatch(aside, /Ready to launch|Complete required fields/);
  const review = text(renderToStaticMarkup(<ReviewStep state={{ ...state, step: "review" }} />));
  assert.doesNotMatch(review, /missing|\$ ·/i, "empty rows stay empty and a blank ticker never reads as a bare $");
  assert.match(review, /— — · Bonding/);
  assert.doesNotMatch(review, /Your coin/);
});

test("the loading Coin card has the loaded card's layout: copy wraps as the real words, the last row is the 40px Advanced row, and it waits 300 ms", () => {
  const html = renderToStaticMarkup(<LaunchLoadingFields />);
  assert.match(html, /class="[^"]*lc-wait[^"]*"/);
  // The logo title and the logo guide are the real words under a bar, so they wrap as the loaded card's do; no field shows help.
  const lines = [...html.matchAll(/class="[^"]*lc-line-skel[^"]*">([^<]+)</g)].map((match) => match[1]);
  assert.deepEqual(lines.slice(0, 2), ["Upload logo", LOGO_GUIDE]);
  assert.equal(lines.length, 2);
  // In order: Name, Ticker, Description, then the Advanced row (a 40px row, not a 44px field) that holds supply.
  const boxes = [...html.matchAll(/class="([^"]*)"/g)].map((match) => /\blc-(?:input|area|static|seg|row)-skel\b/.exec(match[1])?.[0]).filter(Boolean);
  assert.deepEqual(boxes, ["lc-input-skel", "lc-input-skel", "lc-area-skel", "lc-row-skel"]);
});
