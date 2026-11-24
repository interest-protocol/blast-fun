import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { readFileSync } from "#web/test/css-design-px.ts";
import test from "node:test";

/**
 * OA-32 (the gate `design/blast-feel-preview-oa32.html`, sha256 707efdd9…9e32b,
 * its block "Display face: Bricolage Grotesque"): Bricolage Grotesque on the
 * wordmark, page and entity titles and hero figures, Geist everywhere else, at
 * today's sizes. The shell wordmark, PageHeader and SheetHeading
 * now have loaded-font browser coverage in verify-shell-typography.mjs (#799).
 * Keep the font loader/axis contract, other roles and the selector inventory:
 * no unregistered rule draws in the display face.
 */
const SRC = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, SRC), "utf8");
const RULE = /([^{}]*)\{([^{}]*)\}/g;
const rules = (path: string) =>
  [...read(path).replace(/\/\*[\s\S]*?\*\//g, "").matchAll(RULE)].map(
    ([, selector, body]) => [selector!.trim().replace(/\s+/g, " "), body!.trim().replace(/\s+/g, " ")] as const,
  );
const SCOPE = ":global([data-blast-ui]) ";
const unscoped = (selector: string) => (selector.startsWith(SCOPE) ? selector.slice(SCOPE.length) : selector);

/** The 2026-10-27 boards' wordmark: 700 at -.04em (the rail's 23px, the phone header's 21px, Blast mode's header). */
const BOARD_WORDMARK = { weight: "700", spacing: "-.04em", tabular: false };
const TITLE = { weight: "700", spacing: "-.025em", tabular: false };
/** System board (2026-10-27): page titles are 36/650 at -.04em (32 on phones), the size earning the tighter tracking. */
const PAGE_TITLE = { weight: "650", spacing: "-.04em", tabular: false };
const FIGURE = { weight: "700", spacing: "-.02em", tabular: true };
/** System board (2026-10-27): the hero figure, 56/650 at -.045em (the Portfolio total's 58, the Invites volume's 56). */
const HERO_FIGURE = { weight: "650", spacing: "-.045em", tabular: true };
/** The 2026-10-27 boards' card figures: 650 at -.03em, tabular (Profile's 26px tiles, Create's 28px target, Rewards' and Settings' 30px totals). */
const CARD_FIGURE = { weight: "650", spacing: "-.03em", tabular: true };
const MULTIPLIER = { weight: "800", spacing: "-.02em", tabular: true };
/** R3-33: the coin sheet's header title is `.sheet h2`'s face at the gate's `.sheet .coin-top h2` weight (650), as the gate computes it. */
const COIN_TITLE = { weight: "650", spacing: "-.025em", tabular: false };

/** Each role's rule in the app, with the gate selector it stands for. */
const ROLES = [
  ["components/social/profile/Profile.module.css", ".tiles b", CARD_FIGURE], // Profile board: the track-record tiles, 26/650
  // Create boards (2026-10-27): the review hero's coin name (26/650) and the raise target (28/650, a figure).
  ["components/social/create/create.module.css", `${SCOPE}.cr-hero-id .t b`, { ...CARD_FIGURE, tabular: false }],
  ["components/social/create/create.module.css", `${SCOPE}.cr-launch-title`, { weight: "700", spacing: "-.035em", tabular: false }],
  ["components/social/create/create.module.css", `${SCOPE}.cr-launch-ticker`, { weight: "700", spacing: "-.02em", tabular: false }],
  ["components/social/profile/Profile.module.css", ".prof h2", PAGE_TITLE], // Profile board: the name, 32/650 at the page title's -.04em
  ["components/social/competitions/CompetitionScreen.module.css", ".heroName", { weight: "650", spacing: "-.035em", tabular: false }], // Competitions board: the competition name, 30/650
  ["components/social/settings/WalletCard.module.css", ".total", CARD_FIGURE], // Settings board: the wallet total, 30/650
  ["components/social/rewards/Rewards.module.css", ".sideFig", CARD_FIGURE], // Rewards board: the side card's figure, 30/650
  ["components/social/coins/coins.module.css", ".head h2", TITLE], // .sh-head h2
  ["components/social/commit/commit.module.css", ".receipt h2", { weight: "700", spacing: "-.5px", tabular: false }],
  ["components/social/profile/Profile.module.css", ".goldVal", FIGURE], // .gold-val
  ["components/presale-pages/presales.module.css", `${SCOPE}.cd-big`, FIGURE], // .cd-big
  ["components/social/coins/coins.module.css", "[data-blast-ui] .coinTop h2", COIN_TITLE], // .sheet .coin-top h2 (R3-33)
  ["components/social/coins/coins.module.css", ".coinBal b", FIGURE], // .coin-bal b (R3-33's coin screen)
  ["components/presale-pages/presales.module.css", `${SCOPE}.since .mult`, MULTIPLIER], // .since .mult
  ["components/social/portfolio/Portfolio.module.css", ".val", HERO_FIGURE], // Portfolio board: the total, 58/650
  ["components/social/portfolio/Portfolio.module.css", ".welcome h2", { weight: null, spacing: "-.03em", tabular: false }],
  ["components/social/profile/Profile.module.css", ".inviteVolume > strong", HERO_FIGURE], // Invites board: the volume, 56/650
  ["components/presale-pages/FeaturedPresales.module.css", ".identity b", TITLE],
  ["components/presale-pages/FeaturedPresales.module.css", ".funding b", { ...FIGURE, tabular: false }],
  ["components/presale-pages/FeaturedPresales.module.css", ".homeMetric b", { ...FIGURE, tabular: false }],
  // The Presales, Sale and Coin boards (2026-10-27): the hero's name and raise, the sale and coin titles, and the raise and price figures.
  ["components/presale-pages/FeaturedPresales.module.css", ".heroIdentity .identity b", { weight: "650", spacing: "-.035em", tabular: false }],
  ["components/presale-pages/FeaturedPresales.module.css", ".hero .funding b", { weight: "650", spacing: "-.035em", tabular: false }],
  ["components/presale-pages/presales.module.css", `${SCOPE}.sale-name`, PAGE_TITLE],
  ["components/presale-pages/presales.module.css", `${SCOPE}.sale-raised > b`, { weight: "650", spacing: "-.04em", tabular: false }],
  // The upcoming sale's whitelist answer (2026-11-20): the viewer's amount, set like the raise above.
  ["components/presale-pages/presales.module.css", `${SCOPE}.access-figure > b`, { weight: "650", spacing: "-.04em", tabular: false }],
  ["components/social/coins/coins.module.css", ".swapDialog.flow .head h2", { weight: "700", spacing: null, tabular: false }],
  ["components/social/bonding/bonding.module.css", ".featuredTitle b", { weight: "650", spacing: "-.035em", tabular: false }],
  ["components/social/bonding/bonding.module.css", ".featuredRaise", { weight: "650", spacing: "-.04em", tabular: false }],
  ["components/social/bonding/bonding-coin.module.css", ".marketPrice strong", { weight: "650", spacing: "-.04em", tabular: false }],
  ["components/social/bonding/bonding-coin.module.css", ".raised b", { weight: "650", spacing: "-.04em", tabular: false }],
  // Accepted I008 workspace roles retain their typography; the price explicitly preserves tabular figures after its font shorthand.
  ["components/social/blast-mode/workspace/WorkspaceHost.module.css", ".brand strong", BOARD_WORDMARK],
  ["components/social/blast-mode/workspace/WorkspaceHost.module.css", ".dataViewPicker select", { weight: "550", spacing: null, tabular: false }],
  ["components/social/blast-mode/workspace/panels/PresalePanel.module.css", ".header h2", { weight: null, spacing: null, tabular: false }],
  ["components/vesting/Vesting.module.css", ".page .heading h1", { weight: "650", spacing: "-1px", tabular: false }],
  ["components/vesting/Vesting.module.css", ".figures dd", { weight: "600", spacing: null, tabular: false }],
  ["components/vesting/Vesting.module.css", ".amount", { weight: "650", spacing: null, tabular: false }],
  ["components/vesting/Creation.module.css", ".section .amountField input", { weight: "550", spacing: null, tabular: false }],
  ["components/vesting/Creation.module.css", ".summaryAmount", { weight: "600", spacing: "-1px", tabular: false }],
  ["components/vesting/VestingDetail.module.css", ".claimAmount", { weight: "650", spacing: "-1px", tabular: false }],
  ["components/vesting/VestingDetail.module.css", ".balances dd", { weight: "600", spacing: null, tabular: false }],
] as const;

// Only the inventory remains here; browser tests own these roles' effective type.
const BROWSER_DISPLAY_ROLES = [
  "components/blast-ui/AppShell.module.css .brand b",
  "components/blast-ui/PageHeader.module.css .phead h1",
];

const TITLE_OVERRIDES = new Map([
  // The Presales board's hero (2026-10-27) restyles the featured card's name and raise; both are roles of their own above.
  ["components/presale-pages/FeaturedPresales.module.css .heroIdentity .identity b", "font-family: var(--display); font-size: 30px; font-weight: 650; line-height: 1; letter-spacing: -.035em;"],
  ["components/presale-pages/FeaturedPresales.module.css .hero .funding b", "font-family: var(--display); font-size: 34px; font-weight: 650; line-height: 1.1; letter-spacing: -.035em; overflow-wrap: anywhere;"],
  // Purchase and picker headings use the quieter transaction face introduced in #202.
  ["components/social/coins/coins.module.css .flow .head h2", "font-family: var(--font); font-size: 24px; font-weight: 600; line-height: 1.2;"],
  ["components/social/coins/coins.module.css .swapDialog.flow .head h2", "font-family: var(--display); font-size: 23px; font-weight: 700;"],
  // The Swap board's sheet title: the UI face at 22/650, as the shared sheet headings.
  ['components/social/coins/coins.module.css .screen[data-coin-screen="pick"] .head h2', "font-family: var(--font); font-size: 22px; font-weight: 650; line-height: 1.3;"],
  ["components/social/coins/coins.module.css .swapDialog .head h2", "font-family: var(--font); font-size: 22px; font-weight: 650; letter-spacing: -.02em; line-height: 1.3;"],
]);

/**
 * 2026-10-27 redesign (owner-approved canvas): Blast mode's price hero, metric
 * figures and trade amount use the display face. Their weight and tracking are
 * set beside them in the panel modules, per size and breakpoint, so they are
 * listed here rather than as single-rule ROLES.
 */
const REDESIGN_FIGURES = [
  'components/social/blast-mode/workspace/panels/CoinPanel.module.css .hero .priceFigure,:global([data-presentation="focus"]) .priceFigure',
  'components/social/blast-mode/workspace/panels/CoinTrade.module.css :global([data-workspace-section="trade"]) .amountField input',
  'components/social/blast-mode/workspace/panels/CoinTrade.module.css :global([data-workspace-section="trade"]) .currency',
  'components/social/blast-mode/workspace/panels/FocusPanel.module.css .priceMetrics .priceMetric dd :global(.num)',
];

function assertRoleFont(body: string, role: (typeof ROLES)[number][2], selector: string) {
  assert.match(body, /(font-family:\s*var\(--display\);|font:\s*\d+ [^;]+ var\(--display\);)/, selector);
  if (role.weight === null) assert.doesNotMatch(body, /font-weight:|font:/, selector);
  else assert.match(body, new RegExp(`(font-weight:\\s*${role.weight};|font:\\s*${role.weight} )`), selector);
  if (role.spacing === null) assert.doesNotMatch(body, /letter-spacing:/, selector);
  else assert.match(body, new RegExp(`letter-spacing:\\s*-0?${role.spacing.slice(1).replace(".", "\\.")};`), selector);
  assert.equal(/font-variant-numeric:\s*tabular-nums;/.test(body), role.tabular, selector);
}

function assertTypographyOverride(path: string, selector: string, declarations: string) {
  if (!/font-family|font:|font-weight|letter-spacing/.test(declarations)) return;
  assert.equal(declarations, TITLE_OVERRIDES.get(`${path} ${selector}`), `${path} ${selector}`);
}

test("OA-32: next/font self-hosts Bricolage Grotesque with the optical-size axis and no width axis", () => {
  const fonts = read("components/blast-ui/fonts.ts");
  const call = /Bricolage_Grotesque\(\{([^}]*)\}\)/.exec(fonts)?.[1];
  assert.ok(call, "fonts.ts loads Bricolage_Grotesque");
  assert.match(call, /weight: "variable",/);
  assert.match(call, /axes: \["opsz"\],/);
  assert.match(call, /display: "swap",/);
  assert.match(call, /subsets: \["latin"\],/);
  assert.match(call, /variable: "--font-bricolage",/);
  assert.doesNotMatch(call, /wdth|adjustFontFallback|preload: false/);
  // Geist keeps its whole variable axis (100–900), so no weight any rule asks for is rounded.
  assert.equal(fonts.match(/weight: "variable",/g)?.length, 3);
  // The root carries the three faces' variables, as a template or (OA-28 M6) through clsx.
  assert.match(
    read("components/blast-ui/BlastUiRoot.tsx"),
    /className=\{(?:`\$\{geist\.variable\} \$\{geistMono\.variable\} \$\{bricolage\.variable\}`|clsx\(geist\.variable, geistMono\.variable, bricolage\.variable\))\}/,
  );
});

test("OA-32: each display role retains its declared weight, tracking and numeric policy", () => {
  for (const [path, selector, role] of ROLES) {
    const list = rules(path);
    const base = list.filter(([candidate]) => candidate === selector);
    assert.equal(base.filter(([, body]) => /var\(--display\)/.test(body)).length, 1, `${path} ${selector}`);
    const body = base.find(([, declarations]) => /var\(--display\)/.test(declarations))![1];
    assertRoleFont(body, role, selector);
    // No other rule for the element (a breakpoint, a more specific ancestor) puts back Geist's
    // family, weight or tighter tracking: in the gate the display block comes last and wins.
    const tail = unscoped(selector);
    for (const [other, declarations] of list) {
      if (other === selector && declarations === body) continue;
      if (!other.split(",").some((part) => { const p = unscoped(part.trim()); return p === tail || p.endsWith(` ${tail}`); })) continue;
      assertTypographyOverride(path, other, declarations);
    }
  }
});

test("newer display figures retain tabular numerals through their numeric containers", () => {
  for (const [path, selector] of [
    ["components/presale-pages/FeaturedPresales.module.css", ".facts"],
    ["components/presale-pages/FeaturedPresales.module.css", ".homeMetric"],
    ["components/vesting/VestingDetail.module.css", ".token"],
    ["components/social/blast-mode/workspace/panels/Figures.module.css", ".figure"],
  ]) {
    const body = rules(path!).find(([candidate]) => candidate === selector)?.[1];
    assert.match(body ?? "", /font-variant-numeric:\s*tabular-nums;/, `${path} ${selector}`);
  }
});

test("OA-32: nowhere else — no other rule uses the display face, and optical sizing stays automatic", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(new URL(dir, SRC), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${dir}${entry.name}/`);
      else if (entry.name.endsWith(".css")) files.push(`${dir}${entry.name}`);
    }
  };
  walk("components/");
  walk("app/");
  const found = files.flatMap((path) => rules(path).filter(([, body]) => /var\(--display\)|--display:|--font-bricolage|Bricolage/.test(body)).map(([selector]) => `${path} ${selector}`));
  const expected = [...ROLES.map(([path, selector]) => `${path} ${selector}`), ...REDESIGN_FIGURES, ...BROWSER_DISPLAY_ROLES];
  assert.deepEqual(found.filter((entry) => !entry.startsWith("components/blast-ui/blast-ui.css ")).sort(), [...expected].sort());
  for (const path of files) {
    const css = read(path);
    assert.doesNotMatch(css, /"wdth"/, path);
    for (const [, value] of css.matchAll(/font-optical-sizing:\s*([^;}]+)/g)) {
      assert.equal(value!.trim(), "auto", path);
    }
  }
});
