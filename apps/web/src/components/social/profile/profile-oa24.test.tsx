import assert from "node:assert/strict";
import { readFileSync } from "#web/test/css-design-px.ts";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";

import type { ProfilePresale } from "@blast/core/modules/social/contracts/profile-page.ts";

import { WatchlistCard } from "../watchlist/WatchlistCard";
import { CompactStepper } from "./parts";
import { ProfileAsideCards } from "./ProfileAside";

/**
 * OA-24 (the gate `design/blast-feel-preview-oa24.html`, sha256 232e34aa…3017f0a,
 * "Review pass"): the compact stepper of the Presales list names only the step it
 * is on (`.pf-list .stepper.compact li:not(.now) .st-l`). The profile's Deposit
 * and Withdraw (`.gold-actions .btn-lg`) and its holdings card left with the
 * portfolio (R3-76; they are on `/portfolio`, R3-74).
 */
const css = readFileSync(new URL("./Profile.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const RULE = /([^{}]*)\{([^{}]*)\}/g;
const rules = [...css.matchAll(RULE)].map(([, selector, body]) => [selector!.trim(), body!.trim()] as const);

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 3, 11, 47, 19);
const sale = (status: ProfilePresale["status"], over: Partial<ProfilePresale> = {}): ProfilePresale => ({
  presale_id: `0x${"7".padStart(64, "0")}`, symbol: "KSTL", name: "Kestrel", icon_url: "", status, venue: "cetus", start_ms: NOW - 2 * DAY, end_ms: NOW + 2 * DAY,
  fill_pct: 73, quote_symbol: "USDC", quote_decimals: 6, launched_ms: null, first_unlock_ms: null, ...over,
});
const stepsOf = (html: string) => [...new JSDOM(html).window.document.querySelectorAll("ol > li")].map((step) => [
  step.className,
  step.querySelector(".stL")?.textContent,
  step.getAttribute("aria-current") ? "current" : "",
  step.querySelector<HTMLElement>(".stBar")?.style.getPropertyValue("--p") ?? "",
]);

test("OA-24: the compact stepper labels only the current step; the list's label still names it", () => {
  assert.ok(rules.some(([selector, body]) => selector === ".stepper li:not(.now) .stL" && body === "visibility: hidden;"));
  const html = renderToStaticMarkup(<CompactStepper nowMs={NOW} presale={sale("funded")} />);
  assert.match(html, /^<ol aria-label="Presale progress: Closed"/);
  assert.deepEqual(stepsOf(html).map(([cls, label]) => [cls, label]), [["done", "Open"], ["now", "Closed"], ["", "Trading"]]);
});

test("R3-85 (OA-41): the compact stepper fills the line after its step with real progress, and never invents one", () => {
  // Open: from the sale's start to its close (2 days of 4 gone).
  assert.deepEqual(stepsOf(renderToStaticMarkup(<CompactStepper nowMs={NOW} presale={sale("open")} />))[0], ["now", "Open", "current", "0.500"]);
  // Trading ends the sale timeline, regardless of a separate vesting schedule.
  const trading = sale("trading", { launched_ms: NOW - 6 * DAY, first_unlock_ms: NOW + 84 * DAY });
  assert.deepEqual(stepsOf(renderToStaticMarkup(<CompactStepper nowMs={NOW} presale={trading} />))[2], ["now", "Trading", "current", ""]);
  // Funded and upcoming launches have no estimated time to trading.
  for (const presale of [sale("trading", { launched_ms: NOW - 6 * DAY }), sale("funded"), sale("pending")]) {
    assert.doesNotMatch(renderToStaticMarkup(<CompactStepper nowMs={NOW} presale={presale} />), /stBar/, presale.status);
  }
  assert.match(renderToStaticMarkup(<CompactStepper nowMs={NOW} presale={sale("cancelled")} />), /Cancelled · the target was missed/);
  // The gate's compact geometry: 14px dots, 22px over the label, the connector 11px clear of each dot, no entrance.
  const body = (selector: string) => rules.find(([candidate]) => candidate === selector)?.[1] ?? "";
  assert.match(body(".stDot"), /left: 50%; width: 14px; height: 14px; margin-left: -7px;/);
  assert.match(body(".stepper li"), /align-items: center; text-align: center; gap: 2px; padding: 22px 2px 0;/);
  assert.match(body(".stepper li::before"), /left: calc\(50% \+ 11px\); right: calc\(-50% \+ 11px\);/);
  assert.match(body(".stBar"), /transform: scaleX\(var\(--p, 0\)\);/);
  assert.match(body(".now .stDot"), /background: var\(--pink-ink\); box-shadow: 0 0 0 3px var\(--pink-soft\);/);
  assert.ok(!/animation/.test(css.slice(css.indexOf(".stepper {"), css.indexOf(".stepperCancelled"))), "no entrance in a row");
});

test("compact lifecycle steps stay reachable, expose their state, and close at the deadline", () => {
  for (const status of ["pending", "open", "closed", "funded", "trading"] as const) {
    const document = new JSDOM(renderToStaticMarkup(<CompactStepper nowMs={NOW} presale={sale(status)} />)).window.document;
    const steps = [...document.querySelectorAll("li")];
    assert.equal(steps.length, 3, status);
    assert.equal(steps.filter((step) => step.hasAttribute("aria-current")).length, 1, status);
    assert.ok(steps.every((step) => step.getAttribute("aria-label")), "hidden labels remain accessible");
    assert.doesNotMatch(document.body.textContent!, /Claim|Unlocks/);
    if (status === "pending") assert.equal(document.querySelector('[aria-current] .stL')!.textContent, "Opens");
    if (status === "trading") assert.equal(steps.at(-1)!.getAttribute("aria-current"), "step");
  }
  const expired = new JSDOM(renderToStaticMarkup(<CompactStepper nowMs={NOW} presale={sale("open", { end_ms: NOW })} />)).window.document;
  assert.equal(expired.querySelector('[aria-current] .stL')!.textContent, "Closed");
  assert.equal(expired.querySelector(".stBar"), null);
});

/** Each rule with the `@media` it sits in ("" at the top level), so a phone override can be told from the base rule. */
function scoped(text: string): readonly (readonly [media: string, selector: string, body: string])[] {
  const out: (readonly [string, string, string])[] = [];
  const walk = (source: string, media: string) => {
    let depth = 0;
    let start = 0;
    let head = "";
    for (let at = 0; at < source.length; at += 1) {
      if (source[at] === "{") {
        if (depth === 0) {
          head = source.slice(start, at).trim();
          start = at + 1;
        }
        depth += 1;
      } else if (source[at] === "}") {
        depth -= 1;
        if (depth === 0) {
          const body = source.slice(start, at);
          if (head.startsWith("@media")) walk(body, head);
          else out.push([media, head, body.trim()]);
          start = at + 1;
        }
      }
    }
  };
  walk(text, "");
  return out;
}
const PHONE = "@media (max-width: 760px)";
const all = scoped(css);
const find = (media: string, selector: string) => all.filter(([m, sel]) => m === media && sel === selector).map(([, , body]) => body);

test("track-record tiles follow the Profile board: three 16px tiles, the label over the 26/650 figure", () => {
  // Narrow profile containers give PnL its own row; the default layout has three columns.
  assert.deepEqual(find("", ".tiles"), ["display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px;"]);
  assert.deepEqual(find("", ".tiles > div"), ["min-width: 0; padding: 14px 16px; border-radius: 16px; background: var(--raised); display: flex; flex-direction: column; gap: 2px;"]);
  assert.match(find("", ".tiles b")[0] ?? "", /font-family: var\(--display\); font-size: 26px; line-height: 1\.2; font-weight: 650; letter-spacing: -\.03em;/);
});

test("Backed rows: the thesis keeps its one-line ellipsis", () => {
  assert.deepEqual(find("", ".prow .t > .why"), ["color: var(--ink-2); font-variant-numeric: normal;"]);
  assert.match(find("", ".prow .t > span")[0] ?? "", /white-space: nowrap; overflow: hidden; text-overflow: ellipsis;/);
});

test("R3-76 (oa41 `.prof-acts`, `.backbar + .phead`): the own actions wrap, right-aligned", () => {
  assert.deepEqual(find("", ".profActs"), ["grid-column: 3; grid-row: 1; display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end;"]);
  assert.ok(!all.some(([, selector]) => /\.(goldActions|pfSecH|pfSum|glassBtn|g2Bar|g2Legend)\b/.test(selector)), "the own portfolio's rules left with it");
  // The title under a back bar (Settings) loses its top padding at every width: no `@media`, after the phone rule.
  const head = readFileSync(new URL("../../blast-ui/PageHeader.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = scoped(head);
  assert.deepEqual(rules.filter(([, selector]) => selector === ":global([data-back-bar]) + .phead").map(([media, , body]) => [media, body]), [["", "min-height: 0; padding-top: 0;"]]);
  assert.ok(rules.findIndex(([, selector]) => selector === ":global([data-back-bar]) + .phead") > rules.findIndex(([media, selector]) => media === PHONE && selector === ".phead"));
});

test("visual check (Profile board): \"Sharing activity\" beside the handle is the X chip's size, 24px with 12/600 text and 7px corners", () => {
  // Three parts: beats blast-ui.css's `[data-blast-ui] .status` (11px, 22px) without touching its stage colours.
  assert.deepEqual(find("", "[data-blast-ui] .handle :global(.status)"), ["height: 24px; padding: 0 9px; border-radius: var(--r-inner); font-size: 12px; font-weight: 600;"]);
  assert.match(find("", ".xchip")[0] ?? "", /height: 24px; padding: 0 9px; border-radius: var\(--r-inner\);/);
});

test("the profile watchlist receives the server clock without a fixture behavior switch", () => {
  const me = {created: [], positions: [], watchlist: [], coins: [], vestings: []};
  const element = ProfileAsideCards({calls: null, firstName: "Kai", hidden: false, me, nowMs: NOW, own: true});
  const watchlist = element.props.children.find((child: unknown) => (child as {type?: unknown} | null)?.type === WatchlistCard) as {props: {nowMs: number; frozen?: boolean}};
  assert.equal(watchlist.props.nowMs, NOW);
  assert.equal("frozen" in watchlist.props, false);
});
