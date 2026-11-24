import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

/**
 * OA-28 M3: every number the gate animates, classified as it does it, and the
 * app component that draws it. The gate (`design/blast-feel-preview-oa36.html`,
 * sha256 3a1d7f3b…) has exactly two number motions:
 *
 * - **count** — `tweenNum(el, from, to, fmt, dur = .7)`: GSAP `power3.out`,
 *   `fmt(o.v)` written on every update. The app draws these spots through
 *   `TweenNum` with the same formatter, but money figures and counts update in
 *   place, instantly (owner, 2026-10-28): the durations callers name are kept and
 *   change nothing.
 * - **roll** — `roll(el, text, up)`: the whole figure slides out and the new one
 *   in (±100 %, opacity, 280 ms `cubic-bezier(.16,1,.3,1)`). The app draws the
 *   same keyframes in CSS. NumberFlow is not used: it spins only the digits that
 *   changed under a gradient mask, and cannot draw the rocket's empty zero, so it
 *   would not be the gate's roll (OA-28 M3's deviation from OA-30's wording).
 *
 * Everything else the gate writes with `textContent`/`innerHTML` at once:
 * **static**. This table is the record; the tests below hold each component to
 * its row.
 */

type Kind = "count" | "roll" | "static";
type Spot = Readonly<{
  gate: string;
  app: string;
  file: string;
  kind: Kind;
  /** For a count: the duration the gate passes (`TWEEN_NUM_S` key), and whether unmasking counts up from zero. */
  seconds?: "default" | "live" | "lastHour";
  reveal?: boolean;
  /** Text that must be in the file for this row (the component's own wiring). */
  marks?: readonly RegExp[];
}>;

const NUMBER_SPOTS: readonly Spot[] = [
  // ---- count (tweenNum) ----
  // `.gold-val[data-bal]`, the own portfolio card's count: the card left the own profile (R3-76, oa41 `showPf = !own`);
  // someone else's public card never moved.
  {
    gate: "`.sstrip [data-raised0]`, sale page: `paintRaise` → `tweenNum(el, fromR, s.raised, qm)`, .7 s",
    app: "SaleView's Strip, Raised",
    file: "src/components/presale-pages/SaleView.tsx",
    kind: "count",
    seconds: "default",
    // R3-40: a coin-quoted sale's raise counts in its coin (`qm`); a USDC raise reads `184,221 USDC` (owner, 2026-10-27).
    marks: [/<TweenNum format=\{usdc\} value=\{n\(sale\.raised_usd\)\} \/>/, /<CoinTweenNum count=\{count\} \/>/],
  },
  {
    gate: "`.sstrip [data-ppl]`, sale page Backers: `paintRaise` → `tweenNum(…, Math.round(v).toLocaleString)`, .7 s",
    app: "SaleView's Strip, Backers",
    file: "src/components/presale-pages/SaleView.tsx",
    kind: "count",
    seconds: "default",
    marks: [/<TweenNum format=\{wholeCount\} value=\{sale\.participants\} \/>/],
  },
  {
    gate: "`.sr-back [data-ppl]`, presales list row: `paintRaise`, .7 s",
    app: "PresalesList's row, backers",
    file: "src/components/presale-pages/PresalesList.tsx",
    kind: "count",
    seconds: "default",
    marks: [/<TweenNum format=\{wholeCount\} value=\{sale\.participants\} \/> \{sale\.participants === 1 \? "backer" : "backers"\}/],
  },
  {
    gate: "`.mraise [data-raised0]` and `[data-ppl]`, the sale dialog (`saleHead`): `paintRaise`, .7 s",
    app: "CommitDialog's SaleRaise, raised and backers",
    file: "src/components/social/commit/CommitDialog.tsx",
    kind: "count",
    seconds: "default",
    marks: [/<TweenNum format=\{usdc\} value=\{raisedUsd\} \/>/, /<CoinTweenNum count=\{count\} \/>/, /<TweenNum format=\{wholeCount\} value=\{sale\.participants\} \/> backers/],
  },
  {
    gate: "`[data-live=\"people\"]` and `[data-live=\"usd\"]`, \"… in the last hour\": `tweenNum(…, .8)` every 7 s",
    app: "LiveLine (Live activity card, Home's phone card)",
    file: "src/components/social/happening/parts.tsx",
    kind: "count",
    seconds: "lastHour",
    marks: [/value=\{lastHour\.wallets\}/, /value=\{Number\(lastHour\.usd\)\}/],
  },
  // ---- roll (roll) ----
  {
    gate: "`.rocket .roll`: `roll($('.roll', t), rocketCount(p), on)`, 280 ms",
    app: "RocketButton's count",
    file: "src/components/social/post/RocketButton.module.css",
    kind: "roll",
  },
  {
    gate: "`[data-timer]`, `[data-tl]`, `[data-tl2]`: countdowns rewritten each second",
    app: "TimeLeft, laneTimeLeft",
    file: "src/components/presale-pages/bits.tsx",
    kind: "static",
  },

];

const ROOT = join(import.meta.dirname, "..", "..", "..");
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");
const importsTween = (source: string) => /from "(#web\/components\/blast-ui\/|\.\/)use-tween-num(?:\.tsx?)?"/.test(source);

test("the table covers the gate's two number motions, and every count row is drawn by TweenNum with the gate's formatter", () => {
  const kinds = new Set(NUMBER_SPOTS.map((spot) => spot.kind));
  assert.deepEqual([...kinds].sort(), ["count", "roll", "static"]);
  for (const spot of NUMBER_SPOTS.filter((one) => one.kind === "count")) {
    const source = read(spot.file);
    assert.ok(importsTween(source), `${spot.app}: uses TweenNum`);
    for (const mark of spot.marks ?? []) assert.match(source, mark, spot.app);
    if (spot.seconds !== "default") assert.match(source, new RegExp(`TWEEN_NUM_S\\.${spot.seconds}`), `${spot.app}: ${spot.seconds}`);
    assert.equal(/countUpOnReveal: true/.test(source), spot.reveal === true, `${spot.app}: counts up on reveal only if the gate does`);
  }
});

test("every roll row draws the gate's `roll()`: the whole figure ±100 % with opacity, --t3 with --ease-std, none under reduced motion", () => {
  for (const spot of NUMBER_SPOTS.filter((one) => one.kind === "roll")) {
    const css = read(spot.file);
    assert.match(css, /translateY\(-100%\); opacity: 0;/, spot.app);
    assert.match(css, /translateY\(100%\); opacity: 0;/, spot.app);
    assert.match(css, /(\.28s var\(--ease\)|var\(--t3\) var\(--ease-std\))/, spot.app);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none/, spot.app);
  }
  // The gate's roll curve, cubic-bezier(.16,1,.3,1), merged into the one strong ease-out; `--ease` is its alias.
  assert.match(read("src/components/blast-ui/blast-ui.css"), /--ease: var\(--ease-std\)/);
});

test("static number rows retain their immediate figures", () => {
  for (const spot of NUMBER_SPOTS.filter((one) => one.kind === "static")) {
    const source = read(spot.file);
    for (const mark of spot.marks ?? []) assert.match(source, mark, spot.app);
  }
});

test("no hand-built number tween is left: no rAF loop eases a figure and the old hooks are gone", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(path);
    }
  };
  walk(join(ROOT, "src/components"));
  const offenders: string[] = [];
  for (const path of files) {
    const source = readFileSync(path, "utf8");
    const file = relative(ROOT, path);
    // An ease written by hand next to a frame loop is a hand-built tween.
    if (/requestAnimationFrame/.test(source) && /\(1 - t\) \*\* [34]|easeOutCubic|power3Out\(/.test(source)) offenders.push(`${file}: rAF tween`);
    if (/use-tweened-number|useTweenedNumber|RevealedAmount|tweenFigures/.test(source)) offenders.push(`${file}: an old tween`);
  }
  assert.deepEqual(offenders, []);
});
