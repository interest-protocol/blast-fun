import assert from "node:assert/strict";
import { readFileSync } from "#web/test/css-design-px.ts";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { CREATE_MENU_PRESALE_LINE } from "#web/components/blast-ui/CreateMenu.tsx";
import { TickerText } from "#web/components/blast-ui/Ticker.tsx";
import { createMenuPlacement } from "#web/components/blast-ui/create-menu-model.ts";
import { CREATE_HASHI_BTC_QUOTE_TYPE, CREATE_WAL_QUOTE_TYPE, CREATE_USDSUI_QUOTE_TYPE, CREATE_QUOTE_TYPE, CREATE_START_MAX_AHEAD_MS, CREATE_SUI_QUOTE_TYPE, CREATE_TEST_SUI_QUOTE_TYPE } from "@blast/core/modules/social/contracts/create.ts";
import { utc } from "@blast/core/lib/format.ts";
import type { SocialMeAccount } from "@blast/core/modules/social/contracts/me.ts";
import { blankDraft, CREATE_DEFAULT_FEE_POLICY } from "@blast/core/modules/social/create/model.ts";

import { SocialViewerProvider } from "../SignInGate";
import { parseAllowlist } from "./allowlist-csv";
import { createStore, issuesOf, type CreateState } from "./create-store";
import { CreateAside } from "./CreatePreview";
import { checklistOf } from "./create-preview-model";
import { pickerQuotes, QUOTE_PICKER_COPY, quotePickCloseMs, quoteRowHelp, quoteRowStep, quoteSwitchMessage } from "./quote-coins";
import { QuotePicker } from "./QuotePicker";

import { createBlockedReason, publishCostSentence, publishOffLine, reviewGroups, reviewLinks } from "./create-review-model";

import { networkFeesOf, selfAddressOf } from "./create-screen-model";
import { readStepHash, stepOf } from "./create-steps";
import { CreateView } from "./CreateView";
import { CreateLoading } from "./CreateLoading";

import { COVER_GUIDE, coverHint, walletLabel, fieldText, parseField, parseStartField, saleDayOptions, startFieldText } from "./create-field-model";
import { filledSample } from "../../../../../../packages/core/test/fixtures/social/create/create-fixtures.ts";

const WALLET = "0x3f9a8c21d04b7e91a2c5f6e8b3d0794c1e2a5b6f8d9c0e1f2a3b4c5d6e7b1c21";
const NOW = Date.UTC(2026, 9, 3, 18, 0, 0);
const addr = (tag: string) => `0x${tag.padStart(64, "0")}`;


test("fresh forms and repeat launches use an allowed quote without restoring completed inputs", () => {
  try {
    createStore.reset({ quotes: [CREATE_TEST_SUI_QUOTE_TYPE], ownerId: "creator" });
    assert.equal(createStore.get().draft.quote_type, CREATE_TEST_SUI_QUOTE_TYPE);
    assert.equal(createStore.get().draft.venue, "cetus");
    createStore.set({ draft: { ...filledSample(), quote_type: CREATE_TEST_SUI_QUOTE_TYPE }, version: 1 });
    createStore.startNewDraft();
    assert.equal(createStore.get().draft.quote_type, CREATE_TEST_SUI_QUOTE_TYPE);
    assert.equal(createStore.get().draft.venue, "cetus");
    assert.equal(createStore.get().draft.name, "");
    assert.equal(createStore.get().version, 0);
    createStore.reset({ quotes: [CREATE_SUI_QUOTE_TYPE, CREATE_TEST_SUI_QUOTE_TYPE] });
    assert.equal(createStore.get().draft.quote_type, CREATE_SUI_QUOTE_TYPE);
    assert.equal(createStore.get().draft.venue, "cetus");
    createStore.reset({ quotes: [CREATE_SUI_QUOTE_TYPE, CREATE_QUOTE_TYPE] });
    assert.equal(createStore.get().draft.quote_type, CREATE_QUOTE_TYPE);
    assert.equal(createStore.get().draft.venue, "cetus");
    createStore.set({ draft: filledSample() });
    createStore.startNewDraft();
    assert.equal(createStore.get().draft.venue, "cetus");
    const saved = { ...filledSample(), quote_type: CREATE_TEST_SUI_QUOTE_TYPE };
    createStore.reset({ quotes: [CREATE_SUI_QUOTE_TYPE], draft: saved });
    assert.deepEqual(createStore.get().draft, saved, "unfinished amounts must not change when the policy changes");
  } finally {
    createStore.reset();
  }
});

test("a saved USDC draft asks for an allowed quote before opening publish", () => {
  const state = ready({ draft: filledSample(), quotes: [CREATE_TEST_SUI_QUOTE_TYPE], publish: { available: true }, tried: true, step: "raise" });
  assert.deepEqual(issuesOf(state), [{ section: "raise", path: "quote_type", message: "Choose an available raise coin" }]);
  assert.match(view(state), /Choose an available raise coin/);
  const picker = renderToStaticMarkup(<QuotePicker state={{ ...state, quoteOpen: true }} />);
  assert.doesNotMatch(picker, /data-q="USDC"/);
  assert.match(picker, /data-q="TEST_SUI"/);
});

test("the Create route fallback never renders a previous session's draft", () => {
  createStore.reset({ phase: "ready", draft: { ...blankDraft(), name: "Previous private draft" } });
  const html = renderToStaticMarkup(<CreateLoading />);
  assert.doesNotMatch(html, /Previous private draft/);
  assert.match(html, /<fieldset[^>]*disabled=""[^>]*inert=""/);
  assert.match(html, /Loading your draft/);
});

function ready(patch: Partial<CreateState> = {}): CreateState {
  createStore.reset({
    phase: "ready",
    draftId: "00000000-0000-4000-8000-0000000000f1",
    version: 1,
    fees: CREATE_DEFAULT_FEE_POLICY,
    cetusTiers: { [CREATE_QUOTE_TYPE]: [[200, 10_000]], [CREATE_SUI_QUOTE_TYPE]: [[200, 10_000]] },
    bluefinOptions: { status: "ready", min_tick: -443_636, max_tick: 443_636 },
    publish: { available: false, reasons: ["presale_not_deployed", "coin_template_missing"] },
    selfAddress: WALLET,
    nowMs: NOW,
    ...patch,
  });
  return createStore.get();
}

const view = (state: CreateState) =>
  renderToStaticMarkup(<SocialViewerProvider signedIn={state.phase !== "visitor"} sessionPending={state.phase === "loading"}><CreateView onList={() => undefined} onLogo={() => undefined} onRetry={() => undefined} signIn={<a href="/sign-in">Sign in</a>} state={state} /></SocialViewerProvider>);
/** The right column as the shell's slot draws it. */
const aside = (state: CreateState) =>
  renderToStaticMarkup(<SocialViewerProvider signedIn={state.phase !== "visitor"}><CreateAside placement="rail" state={state} /></SocialViewerProvider>);
const errors = (html: string) => [...html.matchAll(/data-err="([^"]+)" id="[^"]+" role="status">([^<]+)</g)].map((match) => `${match[1]}:${match[2]}`);
const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const section = (html: string, id: string) => html.match(new RegExp(`<section[^>]*data-sec="${id}" id="cr-${id}"[^>]*>(.*?)</section>`, "s"))?.[1] ?? "";

const checked = (html: string) => [...(html.match(/<nav aria-label="Steps"[^>]*>(.*?)<\/nav>/s)?.[1] ?? "").matchAll(/<a [^>]*><svg[^>]*>.*?<\/svg>([^<]+)<\/a>/g)].map((match) => match[1]);

test("the presale raise field requires at least 1,000 USDC for a new publish", () => {
  const state = ready({ draft: { ...filledSample(), target: 999.99 }, publish: { available: true }, tried: true, step: "raise" });
  assert.match(view(state), /Set a target of at least 1,000\sUSDC/);
  assert.deepEqual(issuesOf({ ...state, draft: { ...state.draft, target: 1_000 } }), []);
  assert.deepEqual(issuesOf({ ...state, publishLocked: true }), []);
});

test("the presale raise minimum uses the selected coin’s price and the form’s precision", () => {
  const state = ready({
    draft: { ...filledSample(), quote_type: CREATE_SUI_QUOTE_TYPE, target: 292.39 },
    quotes: [CREATE_QUOTE_TYPE, CREATE_SUI_QUOTE_TYPE, CREATE_HASHI_BTC_QUOTE_TYPE],
    publish: { available: true },
    raiseQuotePrice: { quoteType: CREATE_SUI_QUOTE_TYPE, usd: "3.42" },
    tried: true,
    step: "raise",
  });
  assert.match(view(state), /Set a target of at least 292\.4\sSUI/);
  assert.deepEqual(issuesOf({ ...state, draft: { ...state.draft, target: 292.4 } }), []);

  const hashi = { ...state, draft: { ...state.draft, quote_type: CREATE_HASHI_BTC_QUOTE_TYPE, target: 0.01 } };
  assert.match(view(hashi), /Wait for a price or choose another raise coin/);
  const priced = { ...hashi, raiseQuotePrice: { quoteType: CREATE_HASHI_BTC_QUOTE_TYPE, usd: "96000" } };
  assert.match(view(priced), /Set a target of at least 0\.0105\shashiBTC/i);
  const funded = { ...priced, draft: { ...priced.draft, target: 0.0105 } };
  assert.equal(issuesOf(funded).some((issue) => issue.path === "target"), false);
  assert.match(aside({ ...funded, step: "details" }), /of 0\.0105 target/);
});

test("presale creation flags slurs in public text and allows an ordinary name after correction", () => {
  const state = ready({
    draft: { ...filledSample(), name: "NiGg3R Coin", symbol: "SP1C", tagline: "A w.e.t.b.a.c.k. coin" },
    publish: { available: true },
    tried: true,
    step: "token",
  });
  assert.deepEqual(errors(view(state)), [
    "name:Remove the slur from the name.",
    "symbol:Remove the slur from the ticker.",
  ]);
  assert.deepEqual(errors(view({ ...state, step: "details" })), ["tagline:Remove the slur from the short description."]);
  assert.match(aside({ ...state, step: "review" }), /Fix the coin and the short description to publish\./);
  const corrected = { ...state, draft: { ...state.draft, name: "Spice and Sniggers", symbol: "SPICE", tagline: "A community coin" } };
  assert.deepEqual(issuesOf(corrected), []);
});

test("the four steps, as the boards name them: the step bar checks each finished step before the current one and holds the thumb on it", () => {
  for (const [step, title, done] of [["token", "Create a presale", []], ["raise", "Create a presale", ["Coin"]], ["details", "Create a presale", ["Coin", "Raise"]], ["review", "Review and publish", ["Coin", "Raise", "Details"]]] as const) {
    const html = view(ready({ draft: filledSample(), step }));
    assert.match(html, new RegExp(`<h1>${title}</h1>`));
    const bar = html.match(/<nav aria-label="Steps"[^>]*>(.*?)<\/nav>/s)?.[1] ?? "";
    assert.deepEqual([...bar.matchAll(/<a (aria-current="page" )?href="#(\w+)"[^>]*>(.*?)<\/a>/g)].map((match) => match[2]), ["token", "raise", "details", "review"]);
    assert.equal(bar.match(/aria-current="page" href="#(\w+)"/)?.[1], step);
    assert.deepEqual(checked(html), done);
  }
  // Passing a step is not finishing it: a coin with no name stays unchecked.
  assert.deepEqual(checked(view(ready({ draft: { ...filledSample(), name: "" }, step: "details" }))), ["Raise"]);
  // The page asks the shell for its 320px right column.
  assert.match(view(ready()), /data-create-page="" data-shell-aside="medium"/);
});

test("each step holds its board's cards, in order, with no error shown before a field is left", () => {
  const titles = (html: string) => [...html.matchAll(/<section[^>]*data-sec="([a-z]+)"[^>]*>/g)].map((match) => match[1]);
  assert.deepEqual(titles(view(ready({ step: "token" }))), ["token"]);
  const raise = view(ready({ step: "raise" }));
  assert.deepEqual(titles(raise), ["raise", "advanced", "join", "launch", "vesting", "split", "rsplit", "fees"]);
  assert.deepEqual([...raise.matchAll(/id="cr-[a-z]+-title">([^<]+)</g)].map((match) => match[1]), ["Raise", "Advanced", "Who can join", "Launch", "Buyer vesting", "Token split", "Raise split", "Trading fees"]);
  // Raise stays open; every other card is one folded row (Advanced first) that shows its value on one short line, its label at most six words.
  const rows = [...raise.matchAll(/<section[^>]*data-sec="([a-z]+)"[^>]*><h2[^>]*><button[^>]*aria-expanded="(true|false)"[^>]*>.*?id="cr-[a-z]+-title">([^<]+)<\/span> <span[^>]*>· ([^<]+)<\/span>/g)].map(([, id, open, title, value]) => `${id} ${open === "true" ? "open" : "folded"}: ${title} · ${value}`);
  assert.deepEqual(rows, [
    "advanced folded: Advanced · 1% pool fee, opens at publish",
    "join folded: Who can join · Anyone, 30,000 max",
    "launch folded: Launch · At scheduled end, 7-day window",
    "vesting folded: Buyer vesting · Off",
    "split folded: Token split · Buyers 45%, pool 30%, +2",
    "rsplit folded: Raise split · Pool 75%, Blast 2%, +1",
    "fees folded: Trading fees · Holders 50%, you 50%",
  ]);
  const erring = view(ready({ step: "raise", tried: true }));
  // Shown errors (the wallets in both splits) open exactly the rows that hold them.
  assert.deepEqual(errors(erring).map((error) => error.split(".")[0]), ["token_recipients", "token_recipients", "raise_recipients"]);
  assert.deepEqual([...erring.matchAll(/<section[^>]*data-sec="([a-z]+)"[^>]*><h2[^>]*><button[^>]*aria-expanded="true"/g)].map((match) => match[1]), ["split", "rsplit"]);
  for (const row of rows) assert.ok(row.split(": ")[1]!.split(" · ")[0]!.split(" ").length <= 6, row);
  assert.deepEqual(titles(view(ready({ step: "details" }))), ["details"]);
  assert.match(view(ready({ step: "details" })), /data-sec="links" id="cr-links"/);
  assert.deepEqual(errors(raise), []);
  assert.ok(raise.indexOf("Raised in") < raise.indexOf('aria-label="Pool venue"'));
  assert.ok(raise.indexOf('aria-label="Pool venue"') < raise.indexOf('aria-label="Pool fee"'));
  assert.match(raise, /Closes Oct 6, 18:00 UTC\./);
  assert.match(raise, /data-f="start_ms"[^>]*type="datetime-local"[^>]*value=""/);
  assert.match(raise, /Opens when you publish\./);
  assert.match(raise, /At the minimum, 30,000 wallets raise \$300,000, enough for the target/);
  assert.match(raise, /450,000,000 tokens/);
  assert.match(raise, /Paired with the pool’s tokens/);
  assert.equal(raise.match(/\$187,500/g)?.length, 1, "the pool's cash is stated once on Raise");
  assert.match(raise, new RegExp(`<b class="[^"]*cr-me[^"]*">You</b><span class="[^"]*cr-wallet[^"]*" title="${WALLET}">${WALLET.slice(0, 10)}…${WALLET.slice(-8)}</span>`));
  assert.match(raise, /<b class="[^"]*cr-me[^"]*">Holders<\/b><span class="[^"]*cr-wallet[^"]*">Daily rewards to every holder<\/span>/);
});

test("steps map to the checked sections, and hashes (old section links included) open their step", () => {
  assert.equal(stepOf("token"), "token");
  assert.equal(stepOf("token", "tagline"), "details");
  assert.equal(stepOf("links"), "details");
  for (const section of ["raise", "join", "launch", "split", "rsplit", "fees"] as const) assert.equal(stepOf(section), "raise");
  assert.deepEqual(readStepHash("#raise"), { step: "raise", section: null });
  assert.deepEqual(readStepHash("#cr-join"), { step: "raise", section: "join" });
  assert.deepEqual(readStepHash("#cr-links"), { step: "details", section: "links" });
  assert.deepEqual(readStepHash("#cr-token"), { step: "token", section: "token" });
  assert.equal(readStepHash("#elsewhere"), null);
  assert.equal(readStepHash(""), null);
});

test("Cetus is first and selected by default; a Bluefin selection is kept", () => {
  const selections = (html: string) => {
    const group = html.match(/<div aria-label="Pool venue"[^>]*>(.*?)<\/div>/)?.[1] ?? "";
    return [...group.matchAll(/<button aria-pressed="(true|false)"[^>]*>(.*?)<\/button>/g)]
      .map((match) => [match[2]!.replace(/<[^>]+>/g, ""), match[1]]);
  };
  assert.equal(blankDraft().venue, "cetus");
  assert.deepEqual(selections(view(ready({ step: "raise" }))), [["Cetus", "true"], ["Bluefin", "false"]]);
  assert.deepEqual(selections(view(ready({ draft: { ...blankDraft(), venue: "bluefin" }, step: "raise" }))), [["Cetus", "false"], ["Bluefin", "true"]]);
});

test("Launch exposes both timings without lifting limits and review shows the selected timing", () => {
  for (const launch_when_filled of [true, false]) {
    const html = view(ready({ draft: { ...filledSample(), launch_when_filled }, step: "raise" }));
    const launch = section(html, "launch");
    const group = launch.match(/<div aria-label="Launch timing"[^>]*>(.*?)<\/div>/s)?.[1] ?? "";
    assert.deepEqual([...group.matchAll(/<button aria-pressed="(true|false)"[^>]*>(.*?)<\/button>/g)].map((match) => [match[2], match[1]]), [
      ["When target is reached", String(launch_when_filled)], ["At scheduled end", String(!launch_when_filled)],
    ]);
    assert.match(html, launch_when_filled ? /Closes at the target or by/ : /Closes Oct 6, 18:00 UTC/);
    assert.doesNotMatch(html, /aria-label="Stop at the target"/);
    const review = view(ready({ draft: { ...filledSample(), launch_when_filled }, step: "review" }));
    assert.match(review, new RegExp(`<dt>Launch timing</dt><dd class="num"><span>${launch_when_filled ? "When target is reached" : "At scheduled end"}</span></dd>`));
    assert.match(review, launch_when_filled ? /<dt>Closes<\/dt><dd class="num"><span>At the target, or by Oct 6, 18:00 UTC<\/span>/ : /<dt>Closes<\/dt><dd class="num"><span>Oct 6, 18:00 UTC<\/span>/);
  }
  const lifted = view(ready({ draft: { ...filledSample(), launch_when_filled: true, lift: true }, step: "raise" }));
  assert.doesNotMatch(lifted, /aria-label="Stop at the target"/);
  assert.match(lifted, /Stops at the target; the pool can launch once it fills\./);
});

test("Advanced offers only 6 and 9 decimals, defaults to 9, and keeps the selected precision in review", () => {
  const defaults = view(ready());
  assert.match(defaults, /Advanced <span class="[^"]*cr-disclosure-note[^"]*">· 9 decimals<\/span>/);
  assert.match(defaults, /aria-expanded="false"[^>]*data-ui-disclosure=""/);
  const group = defaults.match(/<div aria-label="Coin decimals"[^>]*>(.*?)<\/div>/)?.[1] ?? "";
  assert.deepEqual([...group.matchAll(/<button aria-pressed="(true|false)"[^>]*>(\d+)<\/button>/g)].map((match) => [match[2], match[1]]), [["6", "false"], ["9", "true"]]);
  const selected = view(ready({ draft: { ...filledSample(), decimals: 6 }, step: "review" }));
  assert.match(selected, /<dt>Decimals<\/dt><dd class="num"><span>6<\/span>/);
  assert.match(selected, /<dt>After launch<\/dt><dd class="num"><span>Fixed supply<\/span>/);
});

test("reserved coin names and tickers show actionable errors in the form and review checklist", () => {
  const state = ready({ draft: { ...filledSample(), name: " bLaSt ", symbol: "SUI" }, tried: true });
  const html = view(state);
  assert.deepEqual(errors(html), [
    "name:This name is reserved for an existing coin. Choose another name.",
    "symbol:This ticker is reserved for an existing coin. Choose another ticker.",
  ]);
  assert.match(html, /aria-describedby="cr-error-name" aria-invalid="true" aria-label="Name"/);
  assert.match(html, /aria-describedby="cr-error-symbol" aria-invalid="true" aria-label="Ticker"/);
  assert.doesNotMatch(html, />Available</);
  assert.equal(issuesOf(state).length, 2);
  // A valid ticker reads as available, in ink, never green.
  assert.match(view(ready({ draft: filledSample() })), /<span class="[^"]*cr-ok[^"]*"><svg[^>]*>.*?<\/svg>Available<\/span>/);
});

test("UI-20: a left field shows its error; after Review every error shows (the design's crTouched / crTried)", () => {
  const touched = view(ready({ touched: new Set(["name"]) }));
  assert.deepEqual(errors(touched), ["name:Add a name"]);
  assert.match(touched, /data-ui-field="" data-ui-size="lg" class="[^"]*cr-in[^"]* bad"><input aria-describedby="cr-error-name" aria-invalid="true" aria-label="Name"/);
  assert.deepEqual(errors(view(ready({ tried: true }))), ["name:Add a name", "symbol:Add a ticker"]);
  assert.deepEqual(errors(view(ready({ tried: true, step: "raise" }))), [
    "token_recipients.0.address:Add Team&#x27;s Sui address",
    "token_recipients.1.address:Add Treasury&#x27;s Sui address",
    "raise_recipients.0.address:Add Team&#x27;s Sui address",
  ]);
});

test("the right column per step: how it appears, the Summary and Continue, the preview and what is left, publishing", () => {
  const token = aside(ready());
  assert.match(token, /How it appears/);
  // No sample name or ticker rendered as data: the muted dash for each until there is one.
  assert.match(token, /<b class="[^"]*cr-none[^"]*">—<\/b><span class="[^"]*cr-none[^"]*">—<\/span>/);
  assert.doesNotMatch(token, /Your coin/);
  assert.doesNotMatch(token, /Ticker · Presale/);
  assert.match(token, /data-aside-card=""/);
  const summary = aside(ready({ step: "raise" }));
  assert.match(summary, />Summary</);
  assert.doesNotMatch(summary, /<span>target<\/span>|Blast fee/, "the target and the Blast fee stay in their field and tile");
  assert.match(summary, /<dt>Presale price<\/dt><dd class="num">\$0\.00056<\/dd>/);
  assert.match(summary, /<dt>Launch price<\/dt><dd class="num">\$0\.00063 <span class="[^"]*muted[^"]*">\+13%<\/span><\/dd>/);
  // The FDV is the Launch step's figure, not the Summary's: two prices are enough beside the form.
  assert.doesNotMatch(summary, /Launch FDV/);
  assert.doesNotMatch(summary, /Who can join|<dt>Pool<\/dt>/, "the form beside it already states who can join and the pool");
  assert.match(summary, />Continue<\/button>/);
  const details = aside(ready({ step: "details" }));
  assert.match(details, />Preview</);
  assert.match(details, /<b class="num">\$0<\/b><span>of \$250,000 target<\/span>/);
  assert.match(details, /<span role="status">Complete required fields<\/span>/);
  assert.doesNotMatch(details, /\d of \d|cr-meter/, "the stepper shows progress; no meter or count repeats it (TS-2)");
  const issueLabels = [...details.matchAll(/<button aria-label="([^"]+)"[^>]*>/g)].map((match) => match[1]);
  // Each to-do once (TS-2): the team's address both splits need is listed under the first.
  assert.deepEqual(issueLabels, [
    "Coin: Add a name", "Coin: Add a ticker",
    "Token split: Add Team&#x27;s Sui address", "Token split: Add Treasury&#x27;s Sui address",
  ]);
  // The preview card shows at most three numbers (TS-4): progress, target and the presale price.
  const card = details.match(/<div class="[^"]*cr-preview[^"]*">(.*?)<\/dl><\/div>/)?.[1] ?? "";
  assert.deepEqual([...card.replace(/<[^>]+>/g, " ").matchAll(/[$\d][\d,.]*/g)].map((match) => match[0]), ["$0", "$250,000", "$0.00056"]);
  assert.equal([...details.matchAll(/<li class="[^"]*\bok\b[^"]*">/g)].length, 0, "done sections are not listed: only the to-do list");
  assert.doesNotMatch(aside(ready({ phase: "loading", step: "details" })), /Before publishing/, "while the draft loads only the heading shows");
  assert.deepEqual(issuesOf(ready({ draft: filledSample() })), []);
  assert.match(aside(ready({ draft: filledSample(), step: "details" })), /<span role="status">Ready to publish<\/span>/);
  // The signatures are Review's last folded row; the card keeps Publish, and no warning card (the money sentence says the terms lock).
  const publishing = aside(ready({ draft: filledSample(), step: "review", networkFees: "blast" }));
  assert.match(publishing, /aria-label="Publishing"[^>]*>.*Publish presale<\/button>/);
  assert.doesNotMatch(publishing, /cr-warn|can’t change/);
  // An allowlist just read in the browser (no root yet) counts for the form; the chain's checks wait for the server's summary.
  const listed = ready({ draft: { ...filledSample(), eligibility: "allowlist", allowlist_id: "00000000-0000-4000-8000-000000000a11" }, localAllowlist: { n: 1_200, min: 100, max: 5_000, quoteType: CREATE_QUOTE_TYPE }, step: "raise" });
  assert.deepEqual(issuesOf(listed), []);
  assert.match(view(listed), /1,200 wallets/);
});

test("UI-20: Review says publishing is off and keeps Publish disabled (OA-13); nothing is sent", () => {
  const html = view(ready({ draft: filledSample(), step: "review" }));
  assert.match(html, /role="status">Publishing opens once the presale contract is live on Sui mainnet\. Your draft is saved, so you can publish it from here then\.<\/p>/);
  const publish = html.match(/<button[^>]*cr-publish-btn[^>]*>Publish presale<\/button>/)?.[0] ?? "";
  for (const attribute of [/aria-describedby="[^"]+-off"/, /data-ui-variant="primary"/, /disabled=""/, /aria-disabled="true"/]) assert.match(publish, attribute);
  assert.doesNotMatch(html, /cr-warn|can’t change/, "the lock fact rides the money sentence, which waits until Publish can be pressed");
  // An empty optional row stays blank: no filler rendered as data.
  assert.match(html, /<dt>Links<\/dt><dd class="num"><\/dd>/);
  const text = words(html);
  assert.match(text, /Token 45% to buyers 30% pool · 25% recipients and Blast/);
  assert.match(text, /Team vesting Vests 12 mo, 3-mo cliff/);
  assert.match(text, /Blast 15% of total trading fees/);
  assert.match(text, /Holders 50% of the rest · daily rewards/);
  assert.match(text, /You 50% of the rest/);
  assert.equal(publishOffLine(["quote_unavailable"]), "No allowed raise coin is available right now. Your draft is saved.");
  assert.equal(publishOffLine(["creation_policy"]), "Presale permissions couldn’t be read from Sui. Try again shortly. Your draft is saved.");
  assert.equal(publishOffLine(["quote_unavailable"], false), "No allowed raise coin is available right now.", "the paused sheet's note says it instead");
});

test("UI-20: the form and right column stay visible for every session state but a failed load", () => {
  assert.match(view(ready({ phase: "visitor" })), />Sign in to save your draft<\/p>.*<a href="\/sign-in">Sign in<\/a>/s);
  assert.match(view(ready({ phase: "error" })), /role="alert"><p class="[^"]*">Your draft couldn’t load<\/p>.*Try again<\/button>/s);
  assert.match(view(ready({ phase: "error" })), /<span class="err-code">Code: request_failed\.<\/span>/, "the draft-load error is its title and the code line only");
  assert.doesNotMatch(view(ready({ phase: "error" })), /Check your connection/);
  for (const step of ["token", "raise", "details", "review"] as const) {
    // A draft that could not load replaces the step and its column (as Launch does): nothing to fill in or continue.
    const failed = view(ready({ phase: "error", step }));
    assert.match(failed, /Your draft couldn’t load/);
    assert.doesNotMatch(failed, /data-sec=|<fieldset|Continue to|>Continue<|Presale preview and publishing/, `no form or column on ${step}`);
    assert.equal(aside(ready({ phase: "error", step })), "", `the rail column is empty on ${step}`);
  }
  assert.match(view(ready({ phase: "error", errorMessage: "Your account could not load. Try again." })), /Your account could not load\. Try again\./, "a sentence that says more than the title stays");
  const loading = view(ready({ phase: "loading" }));
  assert.match(loading, /<fieldset[^>]*aria-busy="true"[^>]*disabled=""[^>]*inert=""/);
  assert.deepEqual([...loading.matchAll(/data-sec="([a-z]+)"/g)].map((match) => match[1]), ["token"]);
  assert.match(loading, /disabled="" aria-disabled="true" aria-busy="true"><span aria-label="Loading your draft"[^>]*role="status">/);
  assert.doesNotMatch(view(ready()), /<fieldset[^>]*disabled/);
  const visitor = view(ready({ phase: "visitor", step: "raise" }));
  assert.ok(visitor.includes("data-sec="));
  assert.doesNotMatch(visitor, /<fieldset[^>]*disabled/);
  assert.match(visitor, /Sign in to save/);
  const preview = aside(ready({ phase: "visitor", step: "raise" }));
  assert.match(preview, /Summary/);
  assert.doesNotMatch(preview, /inert=""|disabled=""/);
  assert.match(aside(ready({ phase: "loading", step: "details" })), /class="[^"]*cr-ready[^"]*" inert=""/);
});


test("an allowlist with any invalid row is blocked instead of skipping or changing values", () => {
  const parsed = parseAllowlist(["address,usdc", `${addr("a1")}, $1,000`, `${addr("A1")},50`, "0x12,10", `${addr("b2")};250.5`, `${addr("c3")}\t0`, ""].join("\n"));
  assert.deepEqual(parsed.errors.map((error) => error.line), [2, 6]);
  assert.equal(parsed.csv, "");
  assert.equal(parsed.errorCount, 2);
  const clean = parseAllowlist(`${addr("a1")},1000\n${addr("b2")};250.5\n`);
  assert.deepEqual([clean.n, clean.min, clean.max, clean.errorCount], [2, 250.5, 1000, 0]);
  assert.equal(clean.csv, `wallet,cap\n${addr("a1")},1000000000\n${addr("b2")},250500000\n`);
  assert.equal(parseAllowlist("nothing here").n, 0);
});

test("UI-20: fields type and show as the design's crIn does", () => {
  assert.equal(parseField("sym", "mr-dn1"), "MRDN1");
  assert.equal(parseField("money", "$25,000.555"), 25_000.56);
  assert.equal(parseField("int", "1,000,000,000 tokens"), 1_000_000_000);
  assert.equal(parseField("int", "99999999999999", 655_360), 655_360);
  assert.equal(parseField("pct", "19.5%"), 1_950);
  assert.equal(parseField("addr", "  0xabc "), "0xabc");
  assert.equal(fieldText("pct", 1_950), "19.5");
  assert.equal(fieldText("money", 250_000), "250,000");
  assert.equal(fieldText("int", 30_000), "30,000");
});

test("the Opens field reads and writes the start in the browser's time, by the minute; blank or unfinished opens at publish", () => {
  const at = new Date(2026, 9, 30, 18, 5).getTime();
  assert.equal(startFieldText(null), "");
  assert.equal(startFieldText(at), "2026-10-30T18:05");
  assert.equal(parseStartField("2026-10-30T18:05"), at);
  assert.equal(parseStartField(startFieldText(at)), at);
  assert.equal(parseStartField(""), null);
  assert.equal(parseStartField("2026-10-30"), null);
  assert.equal(parseStartField("soon"), null);
});

test("Raise's Opens: a scheduled start shows in the field, its help, the close and Review; one already past or over 90 days ahead is an issue", () => {
  const DAY = 86_400_000;
  const start = Math.ceil((Date.now() + 2 * DAY) / 60_000) * 60_000;
  const draft = { ...filledSample(), start_ms: start };
  const startIssues = (start_ms: number | null) => issuesOf(ready({ draft: { ...filledSample(), start_ms } })).filter((issue) => issue.path === "start_ms");
  assert.deepEqual(startIssues(null), []);
  assert.deepEqual(startIssues(start), []);
  assert.deepEqual(startIssues(Date.now() - 60_000), [{ section: "raise", path: "start_ms", message: "Pick a time from now on" }]);
  assert.deepEqual(startIssues(Date.now() + CREATE_START_MAX_AHEAD_MS + DAY), [{ section: "raise", path: "start_ms", message: "Open within 90 days" }]);

  const raise = view(ready({ draft, step: "raise" }));
  assert.match(raise, new RegExp(`data-f="start_ms"[^>]*min="${startFieldText(NOW)}" type="datetime-local"[^>]*value="${startFieldText(start)}"`));
  assert.match(raise, new RegExp(`Opens ${utc(start)}\\.`));
  assert.match(raise, new RegExp(`Closes ${utc(start + draft.days * DAY)}\\.`), "the window runs from the scheduled start");
  assert.deepEqual(errors(raise), []);

  const late = view(ready({ draft: { ...filledSample(), start_ms: Date.now() - 60_000 }, tried: true, step: "raise" }));
  assert.ok(errors(late).includes("start_ms:Pick a time from now on"));
  assert.match(late, /aria-describedby="[^"]*-opens-help cr-error-start_ms" aria-invalid="true" data-f="start_ms"/);

  const rows = (start_ms: number | null) => Object.fromEntries(reviewGroups({ ...ready({ draft: { ...filledSample(), start_ms } }), allowlistWallets: null }).find((group) => group.title === "Raise")!.rows.map((row) => [row.key, row.value]));
  assert.equal(rows(null)["Opens"], `When you publish · ${filledSample().days} days`);
  assert.equal(rows(start)["Opens"], `${utc(start)} · ${draft.days} days`);
  assert.equal(rows(start)["Closes"], utc(start + draft.days * DAY));
});

test("UI-20: Create opens below the header plus and above the mobile bottom action", () => {
  assert.deepEqual(createMenuPlacement(), {
    side: "bottom", align: "end", sideOffset: 8, avoid: "shift", originX: "calc(100% - var(--anchor-width, 0px) / 2)",
  });
  assert.deepEqual(createMenuPlacement("mobile"), {
    side: "top", align: "center", sideOffset: 8, avoid: "shift", originX: "50%",
  });
});

test("UI-20: the creator's own fee row shows the Blast wallet, else Slush, else any linked wallet", () => {
  const account = (wallets: SocialMeAccount["wallets"]) => ({ wallets }) as SocialMeAccount;
  assert.equal(selfAddressOf(account([{ address: addr("e1"), kind: "external", linked_at_ms: 1 }, { address: addr("51"), kind: "slush", linked_at_ms: 2 }])), addr("51"));
  assert.equal(selfAddressOf(account([{ address: addr("51"), kind: "slush", linked_at_ms: 2 }, { address: addr("b1"), kind: "embedded", linked_at_ms: 3 }])), addr("b1"));
  assert.equal(selfAddressOf(account([])), null);
  assert.equal(selfAddressOf(null), null);
  assert.ok(blankDraft().fee_recipients[0]!.self);
});


test("Publish is disabled for incomplete drafts, and Review has one fixed-terms sentence and no checkbox", () => {
  const button = (html: string) => html.match(/<button[^>]*cr-publish-btn[^>]*>/)?.[0] ?? "";
  const open = { publish: { available: true } as const };
  const pending = aside(ready({ ...open, step: "review" }));
  assert.match(button(pending), /disabled=""/);
  assert.match(words(pending), /Add a name, a ticker, a team wallet and a treasury wallet to publish\./);
  const complete = aside(ready({ ...open, draft: filledSample(), step: "review", networkFees: "blast" }));
  assert.doesNotMatch(complete, /type="checkbox"|I understand|cr-warn|can’t change/);
  // The one fixed-terms sentence is the money sentence's clause (CreateScreen.test reads it above a live Publish).
  assert.equal(publishCostSentence("blast"), "Publishing moves no coins and locks the sale’s terms. Blast pays the network fees.");
});

/**
 * One main action per screen width. Wide (>= 1220px): the shell shows the rail
 * card, and the page's folded column and action row are display: none. Narrow:
 * the shell's rail is display: none and the page's action row is the only one.
 * display: none also drops the hidden copy from the accessibility tree.
 */
test("each width shows exactly one primary action and one reason line", () => {
  const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
  const create = strip(readFileSync(new URL("./create.module.css", import.meta.url), "utf8"));
  const shell = strip(readFileSync(new URL("../../blast-ui/AppShell.module.css", import.meta.url), "utf8"));
  const hide = create.search(/@media \(min-width: 1220px\) \{ :global\(\[data-blast-ui\]\) :is\(\.cr-aside-inline, \.cr-aside-action\) \{ display: none; \} \}/);
  assert.ok(hide > create.indexOf(":global([data-blast-ui]) .cr-actions { display: flex;"), "the hide follows the action row's display: flex, so it wins the cascade");
  assert.match(shell.match(/@media \(max-width: 1219px\) \{[\s\S]*?\n\}/)?.[0] ?? "", /\n\s*\.aside \{ display: none; \}/);
  const primary = (html: string) => html.match(/data-ui-variant="primary"/g)?.length ?? 0;
  const reasons = (html: string) => html.match(/to publish\.<\/p>/g)?.length ?? 0;
  const blocked = ready({ publish: { available: true }, step: "review" });
  const rail = aside(blocked);
  const page = renderToStaticMarkup(<SocialViewerProvider signedIn><CreateAside placement="page" state={blocked} /></SocialViewerProvider>);
  const [, row = ""] = page.match(/^(<div class="[^"]*cr-aside-action[^"]*">[\s\S]*<\/div>)$/) ?? [];
  assert.ok(row, "with publishing open the page placement is the action row alone: no empty card above the sticky bar");
  assert.doesNotMatch(page, /<aside|cr-publish"/);
  // Off: the folded card holds only the off line, above the action row.
  const off = renderToStaticMarkup(<SocialViewerProvider signedIn><CreateAside placement="page" state={{ ...blocked, publish: { available: false, reasons: ["presale_not_deployed"] } }} /></SocialViewerProvider>);
  assert.match(off, /^<aside[^>]*cr-aside-inline[^>]*><div[^>]*><section aria-label="Publishing" class="[^"]*cr-publish[^"]*"><p class="[^"]*cr-soon[^"]*"[^>]*>[^<]+<\/p><\/section><\/div><\/aside><div class="[^"]*cr-aside-action/);
  // Wide: the rail alone.
  assert.equal(primary(rail), 1);
  assert.equal(reasons(rail), 1);
  // Narrow: the page's action row alone.
  assert.equal(primary(row), 1);
  assert.equal(reasons(row), 1);
  assert.match(row, /aria-describedby="([^"]+-checks)"[^>]*cr-publish-btn[^>]*>[^<]*<\/button><p class="[^"]*cr-note[^"]*" id="\1" role="status">/, "the reason sits under the button");
});

test("the review's coin rows show a long name and ticker in full: the ticker breaks only when it cannot fit, nothing is cut to an ellipsis", () => {
  const symbol = "ABCDEFGHIJKLMNOPQRSTUVWXYZ_12345";
  const html = view(ready({ draft: { ...filledSample(), symbol }, step: "review" }));
  // The name and ticker are the hero, not a row as well; the ticker breaks only when it cannot fit.
  assert.doesNotMatch(html, /Name and ticker/);
  assert.match(html, new RegExp(`<b>Meridian</b><span><span class="ticker">\\$${symbol}</span> · Presale on Blast</span>`));
  assert.match(html, new RegExp(`<dt>Total supply</dt><dd class="num"><span>[\\d,]+ <span class="ticker">${symbol}</span></span></dd>`));
  assert.doesNotMatch(html, /cr-one-line|title="[^"]*ABCDEFGHIJ/);
  const css = readFileSync(new URL("../../blast-ui/blast-ui.css", import.meta.url), "utf8");
  // One shared ticker class: whole when it fits its line, broken anywhere only when it cannot, never clipped.
  assert.match(css, /\[data-blast-ui\] \.ticker \{ min-width: 0; overflow-wrap: anywhere; \}/);
  assert.doesNotMatch(css, /\.ticker[^{]*\{[^}]*(nowrap|overflow: hidden|ellipsis)/);
  // A review value's text may shrink below its longest word, so a long run never starts left of the card.
  assert.match(readFileSync(new URL("./create.module.css", import.meta.url), "utf8"), /\.cr-group dd > span:not\(:has\(img\)\) \{ min-width: 0; \}/);
  // A money sentence sets each whole-word ticker in the shared class, and its box may shrink below that word.
  assert.equal(renderToStaticMarkup(<TickerText symbols={[symbol, "SUI"]} text={`You pay 1 SUI, and get at least 89.9M ${symbol}.`} />),
    `You pay 1 <span class="ticker">SUI</span>, and get at least 89.9M <span class="ticker">${symbol}</span>.`);
  assert.equal(renderToStaticMarkup(<TickerText symbols={["PI"]} text="PIP costs 1 PI." />), 'PIP costs 1 <span class="ticker">PI</span>.');
  assert.match(readFileSync(new URL("./create.module.css", import.meta.url), "utf8"), /\.cr-cost \{ min-width: 0; overflow-wrap: anywhere;/);
});

test("the publish reason names each empty wallet, also beside Sign in, and the review leaves those rows blank", () => {
  const sample = filledSample();
  const draft = { ...sample, token_recipients: sample.token_recipients.map((row) => ({ ...row, address: "" })) };
  const open = { publish: { available: true } as const, step: "review" as const };
  const state = ready({ ...open, draft });
  assert.equal(createBlockedReason(state, issuesOf(state)), "Add a team wallet and a treasury wallet to publish.");
  const signedOut = aside(ready({ ...open, draft, phase: "visitor" }));
  assert.match(words(signedOut), /Sign in Add a team wallet and a treasury wallet to publish\./);
  const splits = reviewGroups({ ...state, allowlistWallets: null }).find((group) => group.title === "Splits")!.rows;
  assert.deepEqual(splits.filter((row) => /wallet$/.test(row.key)).map((row) => [row.key, row.value]), [["Team wallet", ""], ["Treasury wallet", ""], ["Team wallet", ""]]);
  const nameless = ready({ ...open, draft: { ...sample, name: "", symbol: "" } });
  assert.ok(reviewGroups({ ...nameless, allowlistWallets: null }).every((group) => group.rows.every((row) => row.key !== "Name and ticker")));
  // An empty required wallet shows the muted dash. Review opens no group by itself (it fits one phone screen):
  // the Splits row names what is missing, in the attention ink, and a press opens it.
  const review = view(state);
  assert.match(review, /<dt>Team wallet<\/dt><dd[^>]*><span class="[^"]*cr-none[^"]*">—<\/span>/);
  assert.equal(review.match(/aria-expanded="true"/g)?.length ?? 0, 0);
  assert.match(review, /<span id="cr-rv-splits-title">Splits<\/span> <span class="[^"]*cr-disclosure-note[^"]*">· <span class="[^"]*cr-fold-attn[^"]*">Team wallet missing, 1 more<\/span>/);
  assert.match(readFileSync(new URL("./create.module.css", import.meta.url), "utf8"), /\.cr-fold-attn \{ color: var\(--warn\); \}/);
  assert.equal(createBlockedReason(ready({ ...open, draft: sample }), []), "Wait for your draft to finish saving.");
});

test("a recipient's wallet label gains \" wallet\" only when it doesn't already end in it", () => {
  assert.equal(walletLabel("Treasury"), "Treasury wallet");
  assert.equal(walletLabel("Team Wallet"), "Team Wallet");
  assert.equal(walletLabel(" multisig WALLET "), "multisig WALLET");
  assert.equal(walletLabel("Wallets"), "Wallets wallet");
});

test("disabled words, the current step and the switch's off edge stay readable", () => {
  const ui = readFileSync(new URL("../../blast-ui/blast-ui.css", import.meta.url), "utf8");
  const controls = readFileSync(new URL("../../blast-ui/Controls.module.css", import.meta.url), "utf8");
  const create = readFileSync(new URL("./create.module.css", import.meta.url), "utf8");
  // Muted on the track: 4.77:1 light, 5.85:1 dark; faint was 2.18:1 and 2.81:1.
  assert.match(ui, /\.btn-primary\[disabled\] \{ background: var\(--track\); color: var\(--muted\);/);
  assert.match(controls, /\.button:disabled \{ background:var\(--track\); color:var\(--muted\);/);
  // The current step is ink with the page colour inside and no edge, never pink.
  assert.match(create, /\[data-active="true"\] \.cr-launch-step-icon \{ background: var\(--ink\); color: var\(--bg\); border-color: transparent; \}/);
  // The off switch carries a muted edge against the card (5.62:1 light, 6.52:1 dark); on, the ink fill is enough.
  assert.match(create, /\.switch \{[^}]*box-shadow: inset 0 0 0 1px var\(--muted\);/);
  assert.match(create, /\.switch\[aria-checked="true"\] \{ background: var\(--ink\); box-shadow: none; \}/);
});

test("the publish card lists the three signatures; the money sentence says who pays the network fees", () => {
  // The signatures are Review's last folded row, "Signatures · 3 in your wallet"; pressing it lists them.
  const html = view(ready({ draft: filledSample(), step: "review", networkFees: "blast" }));
  assert.match(html, /<span id="cr-rv-signatures-title">Signatures<\/span> <span class="[^"]*cr-disclosure-note[^"]*">· 3 in your wallet<\/span>/);
  assert.deepEqual([...html.slice(html.indexOf("cr-signs")).matchAll(/<span class="[^"]*\bt\b[^"]*"><b>(.*?)<\/b>/g)].map((match) => match[1]!.replace(/<[^>]+>/g, "")), ["Publish $MRDN", "Register the currency", "Create the presale"]);
  assert.match(html, /<b>Publish <span class="ticker">\$MRDN<\/span><\/b>/, "the ticker, as Launch writes it, and no title");
  assert.doesNotMatch(html + aside(ready({ draft: filledSample(), step: "review", networkFees: "blast" })), /cr-fee-row|Three signatures/, "the money sentence above Publish says it once");
  for (const fees of ["blast", "wallet"] as const) {
    const sentence = publishCostSentence(fees)!;
    assert.ok(sentence.split(/\s+/).length <= 25, sentence);
    assert.match(sentence, /^Publishing moves no coins and locks the sale’s terms\. /);
  }
  assert.match(publishCostSentence("blast")!, /Blast pays the network fees\.$/);
  assert.match(publishCostSentence("wallet")!, /Your wallet pays the network fees\.$/);
  assert.equal(publishCostSentence(null), null);
  const account = (wallets: SocialMeAccount["wallets"]) => ({ wallets }) as SocialMeAccount;
  assert.equal(networkFeesOf(account([{ address: addr("51"), kind: "slush", linked_at_ms: 2 }, { address: addr("b1"), kind: "embedded", linked_at_ms: 3 }])), "blast");
  assert.equal(networkFeesOf(account([{ address: addr("51"), kind: "slush", linked_at_ms: 2 }])), "blast", "Blast pays a wallet session's publishing too (owner ruling 2026-11-20)");
  assert.equal(networkFeesOf(null), null);
});

test("Review shows the coin over its cover and every group; the stepper is the one way back to edit", () => {
  const html = view(ready({ draft: filledSample(), step: "review", cover: { url: "https://blob.example/c.webp", width: 1_536, height: 512 } }));
  assert.match(html, /aria-label="Presale terms to review"[^>]*role="region"/);
  assert.match(html, /<div class="[^"]*cr-hero[^"]*has-cover[^"]*" data-surface=""><img alt="Meridian cover"[^>]*src="https:\/\/blob\.example\/c\.webp"/);
  assert.match(html, /<b>Meridian<\/b><span><span class="ticker">\$MRDN<\/span> · Presale on Blast<\/span>/);
  // Each group is one folded row with its short value; a finished draft opens none, so Review and Publish fit one phone screen.
  const groups = [...html.matchAll(/<span id="cr-rv-[a-z-]+-title">([^<]+)<\/span> <span class="[^"]*cr-disclosure-note[^"]*">· ([^<]+)<\/span>/g)];
  assert.deepEqual(groups.map((match) => match[1]), ["Coin", "Raise", "Splits", "Launch", "Trading fees", "Details", "Signatures"]);
  assert.equal(groups[2]![2], "Buyers 45%, pool 30%");
  assert.equal(groups[6]![2], "3 in your wallet");
  // A value with a ticker is one inline run, so the cell's flex gap never splits the ticker from its amount.
  for (const cell of html.match(/<dd[^>]*>.*?<\/dd>/g)!.filter((dd) => dd.includes('class="ticker"'))) assert.match(cell, /^<dd[^>]*>(?:<span[^>]*>(?:[^<]|<span class="ticker">[^<]*<\/span>)*<\/span>)+<\/dd>$/, cell);
  assert.equal(html.match(/aria-expanded="true"/g)?.length ?? 0, 0);
  assert.doesNotMatch(html, /aria-label="Edit |cr-edit/);
  assert.doesNotMatch(view(ready({ draft: filledSample(), step: "review" })), /cr-hero[^"]*has-cover/);
});

// ---- R3-25: the Links section and the cover, the preview's cover slot, the review's links ----

test("R3-25: Details carries the cover at 3:1 with its safe area, the description and the links, with the gate's copy, placeholders and prefixes", () => {
  const html = view(ready({ step: "details" }));
  const links = html.slice(html.indexOf('id="cr-links"'));
  assert.deepEqual([...links.matchAll(/<label class="[^"]*cr-label[^"]*" for="[^"]+">([^<]+)<\/label>/g)].map((match) => match[1]), ["Website", "X", "Telegram", "Docs", "Audit report"]);
  for (const placeholder of ["meridian.finance", "handle", "meridianfx", "docs.meridian.finance", "Link to the PDF or page"]) assert.match(links, new RegExp(`placeholder="${placeholder.replace(/\./g, "\\.")}"`));
  assert.match(links, /<span class="[^"]*pre[^"]*">@<\/span><input[^>]*aria-label="X handle"/);
  assert.match(links, /<span class="[^"]*pre[^"]*">t\.me\/<\/span><input[^>]*aria-label="Telegram"/);
  assert.match(html, /Links <span class="[^"]*cr-disclosure-note[^"]*">· Optional<\/span>/);
  assert.match(html, /<span class="[^"]*cr-label[^"]*">Cover<\/span>/);
  assert.match(html, /<b>3072 × 1024 px<\/b> \(3:1\), at least 1536 × 512 · JPG, PNG or WebP, up to 4 MB<\/span><span>Keep logos and text inside the safe area\./, "the cover guidance matches the stored 3:1 banner and names the enforced 4 MB limit");
  assert.match(html, /<button aria-label="Upload cover image"[^>]*>.*?Upload<\/button>/);
  assert.match(html, /<input accept="image\/png,image\/jpeg,image\/webp" hidden="" type="file" data-ui-file=""\/>/);
  assert.match(html, /cr-cover-frame[^"]*"><span aria-hidden="true" class="[^"]*cr-safe[^"]*"><\/span><span aria-hidden="true" class="[^"]*cr-safe-label[^"]*">Safe area<\/span>/);
  assert.ok(!html.includes(">Remove<"));
  assert.match(html, /Shown on cards and the presale page/);
  const covered = view(ready({ step: "details", cover: { url: "https://blob.example/draft-covers/c.webp", width: 1_536, height: 512 } }));
  assert.match(covered, /<div class="[^"]*cr-cover-frame[^"]*has-cover[^"]*"><img alt="Cover preview" height="512" src="https:\/\/blob\.example\/draft-covers\/c\.webp" width="1536"\/>/);
  assert.match(covered, />Remove<\/button>/);
  assert.match(covered, /<button aria-label="Replace cover image"[^>]*>.*?Replace<\/button>/);
});

test("R3-25-AC-2: each wrong link shows the gate's words once tried, and is a Links item on the checklist", () => {
  const draft = { ...filledSample(), site: "not a site", x_handle: "a".repeat(16), telegram: "abcd", docs_url: "ftp://docs", audit_url: "https://user@a.example" };
  const html = view(ready({ draft, tried: true, step: "details" }));
  assert.deepEqual(errors(html).filter((error) => /^(site|x_handle|telegram|docs_url|audit_url):/.test(error)), [
    "site:Website isn&#x27;t a web address",
    "x_handle:X handles are up to 15 letters, digits or _",
    "telegram:Telegram names are 5 to 32 letters, digits or _",
    "docs_url:Docs isn&#x27;t a web address",
    "audit_url:Audit report isn&#x27;t a web address",
  ]);
  assert.match(html, /aria-expanded="true"[^>]*data-ui-disclosure=""[^>]*>.*?Links/, "a shown link error opens the links");
  const links = checklistOf(issuesOf(createStore.get())).find((row) => row.section === "links")!;
  assert.deepEqual(links.open.map((issue) => issue.message), [
    "Website isn't a web address",
    "Docs isn't a web address",
    "Audit report isn't a web address",
    "X handles are up to 15 letters, digits or _",
    "Telegram names are 5 to 32 letters, digits or _",
  ]);
});

test("the empty cover is quiet and uploaded artwork remains in the preview", () => {
  const plain = aside(ready({ draft: filledSample() }));
  assert.match(plain, /cr-cover-slot"><span>Cover image · not added<\/span>/);
  assert.doesNotMatch(plain, /gradient/);
  const covered = aside(ready({ cover: { url: "https://blob.example/c.webp", width: 1_536, height: 512 }, step: "details" }));
  assert.match(covered, /cr-cover-slot[^"]*has-cover[^"]*"><img alt="" height="512" src="https:\/\/blob\.example\/c\.webp" width="1536"\/><\/div>/);
});

test("R3-25-AC-5: the review lists the stored links, or None yet", () => {
  const draft = { ...filledSample(), site: "meridian.finance", x_handle: "meridianfx", telegram: "meridianfx", docs_url: "", audit_url: "http://audits.example/m.pdf" };
  assert.deepEqual(reviewLinks(draft), [
    ["Website", "https://meridian.finance"],
    ["X", "@meridianfx"],
    ["Telegram", "t.me/meridianfx"],
    ["Audit report", "https://audits.example/m.pdf"],
  ]);
  assert.deepEqual(reviewLinks(filledSample()), []);
  const html = view(ready({ draft, step: "review" }));
  assert.match(html, /<dt>Links<\/dt><dd class="num"><span>https:\/\/meridian\.finance · @meridianfx · t\.me\/meridianfx · https:\/\/audits\.example\/m\.pdf<\/span>/);
  assert.match(html, /<dt>Short description<\/dt><dd class="num"><span>Onchain FX for stablecoins on Sui<\/span>/);
});

test("R3-25-AC-8: the launch card keeps only Liquidity; the Summary states the prices once", () => {
  const html = view(ready({ draft: filledSample(), step: "raise" }));
  const kv = html.match(/<dl class="[^"]*cr-kv[^"]*">(.*?)<\/dl>/s)?.[1] ?? "";
  assert.deepEqual([...kv.matchAll(/<div><dt>([^<]+)<\/dt>/g)].map((match) => match[1]), ["Liquidity"]);
  assert.match(kv, /<dt>Liquidity<\/dt><dd class="num">300,000,000 MRDN \+ \$187,500<\/dd>/);
});

/*
 * R3-42: the "Raise in" row, its picker and the Create menu's line, per the
 * gate (`crRow('Raised in', …)`, `openQuotePicker`, the Create menu).
 */
const SUI_PRICE = { usd_price: "3.42", as_of_ms: NOW - 60_000 };

test("R3-42-AC-1: the Raise card's first field is Raised in, a button naming the coin, with the gate's help line for each coin", () => {
  const usdc = view(ready({ draft: filledSample(), quotes: [CREATE_SUI_QUOTE_TYPE, CREATE_QUOTE_TYPE], step: "raise" }));
  assert.match(usdc, /<button aria-haspopup="dialog" aria-label="Raised in USDC\. Change"[^>]*data-cr-quote="" data-f="quote_type"[^>]*data-ui-disclosure=""[^>]*class="[^"]*cr-quote[^"]*"[^>]*>/);
  assert.match(words(usdc), /Raised in USDC Buyers paying in SUI are swapped to USDC for them\./);
  const sui = view(ready({ draft: { ...filledSample(), quote_type: CREATE_SUI_QUOTE_TYPE, target: 120_000, wallet_cap: 7_300, min_commitment: 3, max_wallets: 40_000 }, quotes: [CREATE_QUOTE_TYPE, CREATE_SUI_QUOTE_TYPE], step: "raise" }));
  assert.match(sui, /aria-label="Raised in SUI\. Change"/);
  assert.match(words(sui), /Raised in SUI Buyers paying in USDC are swapped to SUI for them\./);
  assert.equal(quoteRowHelp("SUI"), "Buyers paying in USDC are swapped to SUI for them.");
  assert.equal(quoteRowHelp("USDC"), "Buyers paying in SUI are swapped to USDC for them.");
  // The card's figures follow the coin: no dollar figure is left in a SUI draft's Raise without a SUI price.
  const raise = sui.slice(sui.indexOf('data-sec="raise"'), sui.indexOf('data-sec="join"'));
  assert.doesNotMatch(words(raise), /\$[0-9]/);
  assert.match(raise, /<span class="[^"]*suf[^"]*"><span class="[^"]*cr-coin[^"]*"><span aria-hidden="true" class="[^"]*cr-qmark[^"]*"[^>]*>.*?<\/span>SUI<\/span><\/span>/);
  assert.match(words(sui), /At the minimum, 40,000 wallets raise 120,000 SUI, enough for the target/);
  // With today's SUI price the target reads in dollars too.
  const priced = view(ready({ draft: { ...filledSample(), quote_type: CREATE_SUI_QUOTE_TYPE, target: 120_000 }, quotes: [CREATE_QUOTE_TYPE, CREATE_SUI_QUOTE_TYPE], suiPrice: { ...SUI_PRICE, usd_price: "3" }, raiseQuotePrice: { quoteType: CREATE_SUI_QUOTE_TYPE, usd: "3.42" }, step: "raise" }));
  assert.match(priced, /≈ \$410,400 today\. The sale closes when it reaches this\./);
});


test("R3-42-AC-1/5, R3-86-AC-2: the picker is oa41's sheet: Raise in, its lead, SUI then USDC as one grouped list with their subtitles, the draft's coin checked, and the footer", () => {
  const html = view(ready({ draft: filledSample(), quotes: [CREATE_SUI_QUOTE_TYPE, CREATE_QUOTE_TYPE], suiPrice: SUI_PRICE, quoteOpen: true }));
  const text = words(html);
  assert.match(text, new RegExp(QUOTE_PICKER_COPY.title));
  assert.match(html, /<div aria-label="Raise in" class="[^"]*\bqp-group" role="radiogroup">/);
  assert.deepEqual([...html.matchAll(/aria-checked="(true|false)"[^>]*data-q="([A-Z]+)"/g)].map((match) => `${match[2]}:${match[1]}`), ["SUI:false", "USDC:true"]);
  assert.match(text, /SUI Target and prices in SUI USDC Target and prices in dollars/);
  // Every row carries the check, shown only on the chosen one (CSS); no ink circle, no `on` fill.
  assert.equal([...html.matchAll(/<span aria-hidden="true" class="[^"]*\bqp-check"><svg[^>]*stroke-width="2.6"/g)].length, 2);
  assert.doesNotMatch(html, /qtick|cr-qpick/);
  assert.doesNotMatch(html, /<p class="[^"]*\bqp-foot">/);
  // Closed, there is no sheet.
  assert.doesNotMatch(view(ready({ draft: filledSample(), quotes: [CREATE_SUI_QUOTE_TYPE, CREATE_QUOTE_TYPE], suiPrice: SUI_PRICE })), /role="radiogroup"/);
});

test("R3-86-AC-2: a pick closes the sheet a beat later (240 ms, none under reduced motion); ↑ / ↓ move between the rows and wrap", () => {
  assert.equal(quotePickCloseMs(false), 240);
  assert.equal(quotePickCloseMs(true), 0);
  assert.equal(quoteRowStep("ArrowDown", 0, 2), 1);
  assert.equal(quoteRowStep("ArrowDown", 1, 2), 0);
  assert.equal(quoteRowStep("ArrowUp", 0, 2), 1);
  assert.equal(quoteRowStep("ArrowUp", 1, 2), 0);
  assert.equal(quoteRowStep("ArrowUp", 0, 1), 0);
  assert.equal(quoteRowStep("ArrowLeft", 0, 2), null);
  assert.equal(quoteRowStep("Enter", 0, 2), null);
  assert.equal(quoteRowStep("ArrowDown", -1, 2), null, "focus on no row: the keys do nothing");
});

test("R3-86-AC-2: the grouped list's geometry is oa41's (8306–8322)", () => {
  const css = readFileSync(new URL("./create.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (selector: string) => {
    const at = css.indexOf(`:global([data-blast-ui]) ${selector} {`);
    assert.ok(at >= 0, selector);
    return css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at)).trim();
  };
  assert.equal(rule(".qp-group"), "display: flex; flex-direction: column; border-radius: var(--r-sm); background: var(--raised); overflow: hidden;");
  assert.match(rule(".qp-row"), /gap: 13px; min-height: 64px; padding: 12px 16px;/);
  assert.match(rule(".qp-row + .qp-row::before"), /left: 63px; right: 0; height: 1px; background: var\(--hair-2\);/);
  assert.equal(rule(".qp-row .t b"), "font-size: 16px; font-weight: 600; letter-spacing: -.01em;");
  assert.equal(rule(".qp-row .t span"), "font-size: 13px; color: var(--muted);");
  assert.match(rule(".qp-check"), /width: 22px; height: 22px; .*color: var\(--ink\); opacity: 0; transform: scale\(\.6\);/);
  assert.equal(rule(".qp-check svg"), "width: 20px; height: 20px; stroke-width: 2.6;");
  assert.equal(rule('.qp-row[aria-checked="true"] .qp-check'), "opacity: 1; transform: none;");
  assert.match(css, /\.qp-row:hover \{ background: color-mix\(in oklab, var\(--ink\) 3%, var\(--raised\)\); \}/);
  assert.equal(rule(".qp-row:active"), "background: color-mix(in oklab, var(--ink) 8%, var(--raised)); transition-duration: 0s;");
  assert.match(rule(".qp-group .qp-row:focus-visible"), /box-shadow: inset 0 0 0 2px var\(--focus-color,var\(--ink\)\);/);
  assert.equal(rule(".qp-foot"), "margin: -8px 4px 0; font-size: 13px; line-height: 1.45; color: var(--muted); text-wrap: pretty;");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ :global\(\[data-blast-ui\]\) \.qp-check \{ transition: none; transform: none; \} \}/);
});

test("R3-42: with no SUI price the picker offers USDC only, and a SUI draft always lists its own coin", () => {
  assert.deepEqual(pickerQuotes([CREATE_QUOTE_TYPE], { quote_type: CREATE_QUOTE_TYPE }).map((quote) => quote.symbol), ["USDC"]);
  assert.deepEqual(pickerQuotes([CREATE_QUOTE_TYPE], { quote_type: CREATE_SUI_QUOTE_TYPE }).map((quote) => quote.symbol), ["SUI", "USDC"]);
  assert.deepEqual(pickerQuotes([CREATE_SUI_QUOTE_TYPE, CREATE_QUOTE_TYPE], { quote_type: CREATE_QUOTE_TYPE }).map((quote) => quote.symbol), ["SUI", "USDC"]);
  const html = renderToStaticMarkup(<QuotePicker state={ready({ draft: filledSample(), quotes: [CREATE_QUOTE_TYPE], suiPrice: null, quoteOpen: true })} />);
  assert.equal(html, "");
  const staticCurrency = view(ready({ draft: filledSample(), quotes: [CREATE_QUOTE_TYPE], step: "raise" }));
  assert.match(staticCurrency, /<span aria-label="Raised in USDC"/);
  assert.doesNotMatch(staticCurrency, /Raised in USDC\. Change|data-cr-quote|role="radiogroup"/);
});

test("R3-42-AC-6: the Create menu's Presale line is the gate's", () => {
  assert.equal(CREATE_MENU_PRESALE_LINE, "Raise SUI or USDC at a set price. The pool launches when it fills.");
  const source = readFileSync(new URL("../../blast-ui/CreateMenu.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Raise USDC at a set price/);
});


test("Review derives its prices, premium and value at launch from the draft and fee policy, and leaves out a figure it can't make", () => {
  const draft = filledSample();
  const launch = (patch: Partial<CreateState>) => {
    const state = ready({ draft, ...patch });
    const rows = reviewGroups({ ...state, allowlistWallets: null }).find((group) => group.title === "Launch")!.rows;
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  };
  const usdc = launch({});
  // Two significant digits tell the two prices apart (TS-4).
  assert.equal(usdc["Presale price"], "$0.00056");
  assert.equal(usdc["Launch price"], "$0.00063 · +13% versus presale");
  assert.equal(usdc["Launch FDV"], "$625K");
  assert.equal(usdc["Pool"], "1% pool fee");
  assert.equal(usdc["Launch window"], "7 days after it closes");
  assert.equal(usdc["Blast fee"], undefined, "the raise fee is stated once, on the Raise step");
  const fees = { ...CREATE_DEFAULT_FEE_POLICY, token_bps: 200 };
  const adjusted = launch({ draft: { ...draft, buyers_bps: 4_400 }, fees });
  assert.equal(adjusted["Launch price"], "$0.00063 · +10% versus presale");
  const sui = launch({ draft: { ...draft, quote_type: CREATE_SUI_QUOTE_TYPE } });
  assert.equal(sui["Presale price"], "0.00056 SUI");
  assert.equal(sui["Launch price"], "0.00063 SUI · +13% versus presale");
  assert.match(launch({ fees: { ...CREATE_DEFAULT_FEE_POLICY, raise_bps: 3_000 } })["Launch price"]!, / · −29% versus presale$/);
  const noPool = launch({ draft: { ...draft, pool_bps: 0 } });
  assert.equal(noPool["Launch price"], undefined);
  assert.equal(noPool["Launch FDV"], undefined);
  const html = view(ready({ draft, step: "review" }));
  assert.match(html, /<dt>Pool<\/dt><dd class="num"><span class="[^"]*"[^>]*title="Bluefin">.*?<\/span><span>1% pool fee<\/span>/);
});

test("trading fee labels distinguish total fees from the remainder, including unequal coin fees", () => {
  const fees = { ...CREATE_DEFAULT_FEE_POLICY, lp_fee_meme_bps: 2_500, lp_fee_quote_bps: 2_500 };
  const html = view(ready({ draft: filledSample(), fees, step: "raise" }));
  const card = section(html, "fees");
  assert.match(card, /Blast fee<\/span><span class="[^"]*cr-tile-sub[^"]*">Trading fees<\/span>/);
  assert.match(card, /<span>Of total trading fees<\/span>/);
  assert.equal([...card.matchAll(/<span class="[^"]*cr-fee-total[^"]*">37\.5%<\/span>/g)].length, 2);
  assert.match(card, /<b>Split of the remaining 75%<\/b><span>100% below = this remainder<\/span>/);
  const unequal = section(view(ready({ draft: filledSample(), fees: { ...fees, lp_fee_meme_bps: 1_000 }, step: "raise" })), "fees");
  assert.equal([...unequal.matchAll(/45% token \/ 37\.5% USDC/g)].length, 2);
  assert.match(unequal, /<span class="[^"]*cr-tile-sub[^"]*">Token \/ USDC fees<\/span>/);
  assert.match(unequal, /Split of the remaining 90% of token fees \/ 75% of USDC fees/);
});

test("the readiness checklist includes launch policy issues in its count and navigation", () => {
  const state = ready({ draft: { ...filledSample(), pool_fee: 999_999 }, step: "details" });
  const issues = issuesOf(state);
  assert.equal(issues.length, 1);
  assert.equal(checklistOf(issues).flatMap((group) => group.open).length, issues.length);
  const preview = aside(state);
  assert.match(preview, /<button aria-label="Raise: Pick a fee Bluefin offers"/);
  assert.equal([...preview.matchAll(/<li class="[^"]*\btodo\b[^"]*">/g)].length, 1, "only the Raise section is left to do");
  assert.match(view({ ...state, step: "raise" }), /<select aria-label="Pool fee" data-f="pool_fee"/);
});

test("the preview card and the readiness card stay separate; the blank form keeps its placeholders", () => {
  const html = aside(ready({ step: "details" }));
  assert.match(html, /<\/dl><\/div><div class="[^"]*cr-ready[^"]*"/);
  assert.equal([...html.matchAll(/Complete required fields/g)].length, 1);
  const blank = view(ready());
  assert.match(blank, /placeholder="e.g. Meridian"/);
  assert.match(blank, /placeholder="e.g. MRDN"/);
  assert.match(blank, />Upload logo<\/span>/);
  assert.match(blank, /512 × 512 px · square PNG, JPG or WebP, up to 2 MB/);
  const raise = view(ready({ step: "raise" }));
  assert.match(raise, /Maximum participating wallets/);
  // A recipient's vesting is the same switch as the buyers'.
  assert.match(raise, /aria-checked="false" aria-label="Token split: Vesting for [^"]+" class="[^"]*switch[^"]*" role="switch"/);
  assert.doesNotMatch(raise, /Vesting off|all slots must reach the target/);
});


test("the fake quote is visibly labeled and uses configured DEX availability", () => {
  const state = ready({ draft: { ...filledSample(), quote_type: CREATE_TEST_SUI_QUOTE_TYPE }, quotes: [CREATE_QUOTE_TYPE, CREATE_TEST_SUI_QUOTE_TYPE], quoteOpen: true, step: "raise" });
  const html = view(state);
  assert.match(html, /TEST_SUI/);
  assert.match(html, /Fake coins for testing/);
  const raise = html.slice(html.indexOf('data-sec="raise"'), html.indexOf('data-sec="join"'));
  assert.match(raise, /<span class="[^"]*suf[^"]*"><span class="[^"]*cr-coin[^"]*"><span aria-hidden="true" class="[^"]*cr-qmark[^"]*"[^>]*>.*?<\/span>TSUI<\/span><\/span>/);
  assert.match(html, /Bluefin/);
  assert.match(html, /Cetus/);
  const picker = renderToStaticMarkup(<QuotePicker state={state} />);
  assert.match(picker, /Buyers need TSUI/);
  assert.match(picker, /has no real value/);
  assert.match(words(aside(state)), /TSUI/);
  assert.doesNotMatch(words(aside(state)), /TEST_SUI/);
});



test("review shows independently selected cliff and vesting units", () => {
  const draft = filledSample();
  const weekly = { ...draft.token_recipients[0]!, cliff: 2, cliff_unit: "weeks", duration: 6, duration_unit: "months" } as const;
  const minute = { ...draft.raise_recipients[0]!, vest: true, cliff: 1, cliff_unit: "minutes", duration: 5, duration_unit: "minutes" } as const;
  const text = words(view(ready({ draft: { ...draft, token_recipients: [weekly, draft.token_recipients[1]!], raise_recipients: [minute] }, step: "review" })));
  assert.match(text, /Team vesting Vests 6 mo, 2-wk cliff/);
  assert.match(text, /Team raise vesting Vests 5 min, 1-min cliff/);
});

test("the short description is a bounded catalog line with its character count", () => {
  const html = view(ready({ draft: { ...filledSample(), tagline: "🚀".repeat(120) }, step: "details" }));
  assert.match(html, /Short description/);
  assert.match(html, /120 \/ 120/);
});


test("USDsui is the third quote with its own mark and explicit unchanged-amount notice", () => {
  const offered = [CREATE_SUI_QUOTE_TYPE, CREATE_QUOTE_TYPE, CREATE_USDSUI_QUOTE_TYPE];
  const draft = { ...filledSample(), quote_type: CREATE_USDSUI_QUOTE_TYPE };
  const quotes = pickerQuotes(offered, draft);
  assert.deepEqual(quotes.map(quote => quote.symbol), ["SUI", "USDC", "USDsui"]);
  const html = renderToStaticMarkup(<QuotePicker state={ready({ draft, quotes: offered, quoteOpen: true })} />);
  assert.deepEqual([...html.matchAll(/data-q="([^"]+)"/g)].map(match => match[1]), ["SUI", "USDC", "USDsui"]);
  assert.match(html, /3239126153783930158.png/);
  assert.match(html, /Target and prices in USDsui/);
  assert.equal(quoteRowHelp("USDsui"), "Buyers paying in SUI are swapped to USDsui for them.");
  assert.equal(quoteSwitchMessage(quotes[1]!, quotes[2]!), QUOTE_PICKER_COPY.unchanged);
  assert.equal(quoteSwitchMessage(quotes[0]!, quotes[2]!), QUOTE_PICKER_COPY.unchanged);
  assert.equal(quoteSwitchMessage(quotes[0]!, quotes[1]!), QUOTE_PICKER_COPY.converted);
});


test("Cetus selection and pool fees follow the selected quote's live reservation tiers", () => {
  let state = ready({ draft: { ...filledSample(), quote_type: CREATE_USDSUI_QUOTE_TYPE }, quotes: [CREATE_QUOTE_TYPE, CREATE_USDSUI_QUOTE_TYPE], step: "raise" });
  const group = view(state).match(/<div aria-label="Pool venue"[^>]*>(.*?)<\/div>/)?.[1] ?? "";
  assert.match(group, /<button[^>]*disabled=""[^>]*>.*?Cetus/);
  createStore.edit((draft) => ({ ...draft, venue: "cetus" }));
  assert.equal(createStore.get().draft.venue, "bluefin");
  assert.equal(createStore.get().draft.quote_type, CREATE_USDSUI_QUOTE_TYPE);

  state = ready({ draft: { ...filledSample(), venue: "cetus", pool_fee: 3_000 }, tried: true, step: "raise" });
  assert.ok(issuesOf(state).some((issue) => issue.path === "pool_fee" && /Cetus/.test(issue.message)));
  const fees = view(state).match(/<select[^>]*aria-label="Pool fee"[^>]*>(.*?)<\/select>/)?.[1] ?? "";
  assert.match(fees, /disabled=""[^>]*value="3000"/);
  assert.deepEqual([...fees.matchAll(/<option(?! disabled)[^>]*value="(\d+)"/g)].map((match) => Number(match[1])), [10_000]);

  ready({ draft: { ...filledSample(), pool_fee: 3_000 } });
  createStore.edit((draft) => ({ ...draft, venue: "cetus" }));
  assert.equal(createStore.get().draft.pool_fee, 10_000);
  assert.equal(issuesOf(createStore.get()).length, 0);
});


test("coin changes choose a compatible DEX and fee, preferring Cetus; unavailable changes preserve terms", () => {
  const initial = ready({ draft: { ...filledSample(), venue: "cetus", pool_fee: 10_000 }, quotes: [CREATE_QUOTE_TYPE, CREATE_USDSUI_QUOTE_TYPE], bluefinOptions: { status: "ready", min_tick: -10, max_tick: 10 } });
  createStore.edit((draft) => ({ ...draft, quote_type: CREATE_USDSUI_QUOTE_TYPE }));
  assert.equal(createStore.get().draft.quote_type, CREATE_USDSUI_QUOTE_TYPE);
  assert.equal(createStore.get().draft.target, initial.draft.target);
  createStore.edit((draft) => ({ ...draft, venue: "bluefin" }));
  assert.equal(createStore.get().draft.venue, "bluefin");
  assert.equal(createStore.get().draft.pool_fee, 500);
  createStore.edit((draft) => ({ ...draft, quote_type: CREATE_USDSUI_QUOTE_TYPE }));
  assert.equal(createStore.get().draft.quote_type, CREATE_USDSUI_QUOTE_TYPE);
  assert.equal(issuesOf(createStore.get()).length, 0);
  createStore.edit((draft) => ({ ...draft, quote_type: CREATE_QUOTE_TYPE }));
  assert.equal(createStore.get().draft.venue, "cetus");
  assert.equal(createStore.get().draft.pool_fee, 10_000);
  ready({ draft: { ...filledSample(), venue: "cetus" }, bluefinOptions: { status: "unavailable" } });
  createStore.edit((draft) => ({ ...draft, venue: "bluefin" }));
  assert.equal(createStore.get().draft.venue, "cetus");
});


test("restored incompatible drafts and failed config reads block review without changing saved terms", () => {
  for (const venue of ["cetus", "bluefin"] as const) {
    const draft = { ...filledSample(), venue };
    const state = ready({ draft, cetusTiers: null, bluefinOptions: { status: "unavailable" }, tried: true, step: "raise" });
    assert.deepEqual(state.draft, draft);
    assert.ok(issuesOf(state).some((issue) => issue.section === "raise"));
    const html = view(state);
    assert.match(html, /<select[^>]*aria-label="Pool fee"[^>]*disabled=""/);
    assert.match(html, /DEX availability could not be verified for this coin/);
  }
  const state = ready({ draft: filledSample(), cetusTiers: null });
  assert.equal(issuesOf(state).length, 0, "a failed Cetus read leaves verified Bluefin available");
});


test("buyer vesting controls and review identify the claim-relative start", () => {
  const draft = filledSample();
  const on = { ...draft, buyer_vesting: { ...draft.buyer_vesting, vest: true } };
  const html = view(ready({ draft: on, step: "raise" }));
  assert.match(html, /aria-checked="true" aria-label="Presale buyers vesting"[^>]*role="switch"/);
  assert.match(html, /data-f="buyer_vesting.vest"[^>]*aria-controls="([^"]+)"/);
  assert.match(html, /Unlocks evenly over 12 mo from each buyer’s claim/);
  assert.doesNotMatch(html, /cr-vest-chart/, "the schedule is said by the row, the inputs and one sentence; no chart repeats it (TS-2)");
  assert.match(words(view(ready({ draft: on, step: "review" }))), /Buyer vesting Vests 12 mo · from each buyer’s claim/);
  const off = view(ready({ draft, step: "raise" }));
  assert.match(off, /aria-checked="false" aria-label="Presale buyers vesting"[^>]*role="switch"/);
  // The team's schedule in one sentence, the cliff spelled as everywhere else.
  assert.match(off, /Vests 12 mo, 3-mo cliff · counts from launch/);
});

test("lift capacity retains cents when one open slot contributes less than a dollar", () => {
  const draft = { ...filledSample(), eligibility: "allowlist" as const, allowlist_id: "00000000-0000-4000-8000-000000000a11", lift: true, lift_access: "anyone" as const, lift_max_wallets: 2, lift_min: 0.01 };
  const html = view(ready({ draft, localAllowlist: { n: 1, min: 10, max: 10, quoteType: CREATE_QUOTE_TYPE }, step: "raise" }));
  assert.match(html, /Minimum-contribution capacity: <strong>\$0\.01<\/strong>/);
});


test("WAL has its own picker mark, coin amounts, and unchanged-amount notice", () => {
  const offered = [CREATE_SUI_QUOTE_TYPE, CREATE_QUOTE_TYPE, CREATE_USDSUI_QUOTE_TYPE, CREATE_WAL_QUOTE_TYPE];
  const draft = { ...filledSample(), venue: "cetus" as const, quote_type: CREATE_WAL_QUOTE_TYPE };
  const quotes = pickerQuotes(offered, draft);
  const tiers = Object.fromEntries(offered.map((type) => [type, [[200, 10_000]] as const]));
  const state = ready({ draft, quotes: offered, quoteOpen: true, cetusTiers: tiers, step: "raise" });
  const html = renderToStaticMarkup(<QuotePicker state={state} />);
  assert.deepEqual([...html.matchAll(/data-q="([^"]+)"/g)].map(match => match[1]), ["SUI", "USDC", "USDsui", "WAL"]);
  assert.match(html, /9842075661773840743.png/);
  assert.match(html, /Target and prices in WAL/);
  const wal = quotes.find((quote) => quote.symbol === "WAL")!;
  for (const other of quotes.filter((quote) => quote.symbol !== "WAL")) {
    assert.equal(quoteSwitchMessage(other, wal), QUOTE_PICKER_COPY.unchanged);
    assert.equal(quoteSwitchMessage(wal, other), QUOTE_PICKER_COPY.unchanged);
  }
  const form = view({ ...state, quoteOpen: false });
  assert.match(form, /Raised in WAL/);
  assert.match(renderToStaticMarkup(<QuotePicker state={{ ...state, cetusTiers: { [CREATE_QUOTE_TYPE]: [[200, 10_000]] } }} />), /data-q="WAL"/);
});


test("fresh drafts fall back to Bluefin while saved DEX choices survive configuration loads", () => {
  const config = { phase: "ready" as const, quotes: [CREATE_USDSUI_QUOTE_TYPE], cetusTiers: { [CREATE_QUOTE_TYPE]: [[200, 10_000] as const] }, bluefinOptions: { status: "ready" as const, min_tick: -10, max_tick: 10 } };
  createStore.reset(config);
  assert.equal(createStore.get().draft.quote_type, CREATE_USDSUI_QUOTE_TYPE);
  assert.equal(createStore.get().draft.venue, "bluefin");
  assert.equal(createStore.get().draft.pool_fee, 500);
  assert.equal(createStore.get().dirty, false);
  const saved = { ...blankDraft(CREATE_USDSUI_QUOTE_TYPE), venue: "cetus" as const };
  createStore.reset({ ...config, draft: saved });
  assert.deepEqual(createStore.get().draft, saved);
});

test("all listed quotes use their verified Cetus tier without a test-coin override", () => {
  ready({ draft: { ...filledSample(), venue: "cetus", pool_fee: 10_000 }, quotes: [CREATE_QUOTE_TYPE, CREATE_TEST_SUI_QUOTE_TYPE], cetusTiers: { [CREATE_QUOTE_TYPE]: [[200, 10_000]], [CREATE_TEST_SUI_QUOTE_TYPE]: [[200, 10_000]] } });
  createStore.edit((draft) => ({ ...draft, quote_type: CREATE_TEST_SUI_QUOTE_TYPE }));
  assert.equal(createStore.get().draft.venue, "cetus");
  createStore.edit((draft) => ({ ...draft, venue: "cetus" }));
  assert.equal(createStore.get().draft.venue, "cetus");
  createStore.edit((draft) => ({ ...draft, quote_type: CREATE_QUOTE_TYPE }));
  assert.equal(createStore.get().draft.venue, "cetus");
});


test("missing DEX configuration disables the empty coin picker and gives a recovery message", () => {
  const html = view(ready({ cetusTiers: null, bluefinOptions: { status: "unavailable" }, step: "raise" }));
  assert.match(html, /data-cr-quote="" data-f="quote_type"[^>]*disabled=""/);
  assert.match(html, /Reload to try again\. Your draft is kept\./);
});


test("final presale review preserves inspectable raise, token and fee destinations", () => {
  const draft = filledSample();
  const extra = addr("f1");
  const html = view(ready({ draft: { ...draft, fee_recipients: [...draft.fee_recipients, { self: false, label: "Operations", address: extra, bps: 1000 }] }, selfAddress: WALLET, step: "review" }));
  for (const address of [...draft.raise_recipients, ...draft.token_recipients].map(row => row.address).concat(extra, WALLET)) {
    assert.ok(html.includes(`Inspect full recipient address: ${address}`), address);
  }
});


test("a picked cover that is small or far from 3:1 gets a note, never a block", () => {
  assert.equal(coverHint(COVER_GUIDE.width, COVER_GUIDE.height), null);
  assert.equal(coverHint(1536, 512), null);
  assert.equal(coverHint(3000, 1000), null);
  assert.equal(coverHint(1500, 500), "This image is 1500 × 500 px. Use at least 1536 × 512 px so it stays sharp.");
  assert.equal(coverHint(1920, 1080), "This image is 1920 × 1080 px, not about 3:1, so more of it will be cropped.");
  assert.equal(coverHint(800, 800), "This image is 800 × 800 px. Use at least 1536 × 512 px at about 3:1 so it stays sharp and nothing important is cropped.");
  assert.equal(coverHint(0, 0), null);
});

test("after a reload the cover note comes from the stored upload's size, and a cover stored before it was recorded gets none", () => {
  const cover = { url: "https://blob.example/draft-covers/c.webp", width: 1_536, height: 512 };
  const small = view(ready({ step: "details", cover: { ...cover, source: { width: 1_500, height: 500 } } }));
  assert.match(small, /cr-cover-hint[^"]*" role="status">This image is 1500 × 500 px\. Use at least 1536 × 512 px so it stays sharp\.</);
  for (const source of [{ width: 3_000, height: 1_000 }, null, undefined]) {
    assert.doesNotMatch(view(ready({ step: "details", cover: { ...cover, source } })), /cr-cover-hint/);
  }
});

test("draft prices never print in exponent form", async () => {
  const { draftPrice } = await import("./create-money");
  const usdc = blankDraft();
  assert.equal(draftPrice(usdc, 0.000556), "$0.000556");
  assert.equal(draftPrice(usdc, 0.0000005), "$0.0₆5");
  assert.equal(draftPrice(usdc, 3.42), "$3.42");
  assert.doesNotMatch(draftPrice(usdc, 1.23e-12), /e/);
});

test("Runs for offers 1, 3 and 7 days; a draft saved at 14 days keeps it as a fourth, selected option", () => {
  assert.deepEqual(saleDayOptions(3), [1, 3, 7]);
  assert.deepEqual(saleDayOptions(14), [1, 3, 7, 14]);
  const runsFor = (days: 3 | 14) => {
    const html = view(ready({ draft: { ...filledSample(), days }, step: "raise" }));
    const group = html.match(/<div[^>]*aria-label="Runs for"[^>]*>(.*?)<\/div>/s)?.[1] ?? "";
    return [...group.matchAll(/<button aria-pressed="(true|false)"[^>]*>([^<]+)<\/button>/g)].map(([, on, text]) => `${text}${on === "true" ? " (on)" : ""}`);
  };
  assert.deepEqual(runsFor(3), ["1 day", "3 days (on)", "7 days"]);
  assert.deepEqual(runsFor(14), ["1 day", "3 days", "7 days", "14 days (on)"]);
});
