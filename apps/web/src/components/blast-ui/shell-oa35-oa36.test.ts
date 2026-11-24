import assert from "node:assert/strict";
import { readFileSync } from "#web/test/css-design-px.ts";
import test from "node:test";

const squash = (value: string) => value.replace(/\s+/g, " ").trim();

type Rule = Readonly<{ media: string | null; selector: string; body: string }>;

/** Flat rules with the `@media` they sit in (one level, as these files have). */
function rules(css: string): Rule[] {
  const out: Rule[] = [];
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let media: string | null = null;
  let depth = 0;
  let start = 0;
  let selector = "";
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    switch (c) {
    case "{": {
      const head = squash(source.slice(start, i));
      if (head.startsWith("@media")) {
        media = head.slice(6).trim();
        depth = 1;
      } else selector = head;
      start = i + 1;
      break;
    }
    case "}": {
      const body = squash(source.slice(start, i));
      if (selector) out.push({ media: depth ? media : null, selector, body });
      else if (depth) {
        media = null;
        depth = 0;
      }
      selector = "";
      start = i + 1;
      break;
    }
    }
  }
  return out;
}

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const base = rules(read("./blast-ui.css"));
const shell = rules(read("./AppShell.module.css"));
const find = (list: Rule[], selector: string, media: string | null = null) => {
  const found = list.filter((rule) => rule.selector === selector && rule.media === media);
  assert.ok(found.length, `no rule ${media ? `@media ${media} ` : ""}${selector}`);
  return found.map((rule) => rule.body).join(" ");
};
const has = (body: string, declaration: string) => assert.ok(body.includes(declaration), `${declaration} in { ${body} }`);

test("boards: the rail is 248px, the right column 300px and 20px from the view, the page 1180px with 40px gutters", () => {
  has(find(base, "[data-blast-ui]"), "--rail: 248px; --aside: 300px; --gap: 20px; --page-gutter: 40px; --page-max: 1180px;");
  // Proportional scale: the column keeps the board's width at every desktop size, so no wide-screen override is left.
  assert.ok(!base.some((rule) => rule.media === "(min-width: 1680px)" && /--aside/.test(rule.body)));
  // Nothing in the shell still carries an old column (344/368/396/420) or a width derived from it.
  for (const file of ["./blast-ui.css", "./AppShell.module.css"]) assert.doesNotMatch(read(file), /\b(344|368|396|420|375\.6)px\b/, file);
  // The column itself and its content take the token.
  has(find(shell, ".asideFull"), "width: var(--aside);");
  // The shell spaces the column's cards 16px apart (the Portfolio and Profile boards); pages pass their cards without a wrapper.
  has(find(shell, ".asideFull"), "gap: 16px;");
  // Settings asks for its board's 336px "Your wallet" column.
  has(find(shell, '.shell:has(:global([data-shell-aside="settings"]))'), "--aside: 336px;");
});

test("boards: the page column ends 40px inside 1180px beside the right column, and the view fills it from the content edge", () => {
  has(find(shell, ".shell"), "grid-template-columns: var(--rail) minmax(0, calc(var(--page-max) - var(--page-gutter) - var(--aside))) var(--aside) minmax(var(--page-gutter), 1fr);");
  has(find(shell, ".main"), "padding: 0 var(--gap) 64px var(--page-gutter);");
  has(find(shell, ".view"), "min-width: 0; margin: 0;");
  // Without a right column the page takes the whole 1180px, gutters on both sides.
  has(find(shell, ".shell[data-no-aside], :global([data-aside=\"collapsed\"]) .shell[data-no-aside]"), "grid-template-columns: var(--rail) minmax(0, var(--page-max)) minmax(0, 1fr);");
  has(find(shell, ".shell[data-no-aside] .main"), "padding-right: var(--page-gutter);");
  // Below 1220 the column goes and the page takes its place.
  has(find(shell, ".aside", "(max-width: 1219px)"), "display: none;");
  has(find(shell, ".main", "(max-width: 1219px)"), "padding-right: var(--page-gutter);");
});

test("Backer avatars keep their compact stack", () => {
  const happening = rules(read("../social/happening/Happening.module.css"));
  has(find(happening, ".pile"), "flex: none;");
  has(find(happening, ".pile > span"), "width: 18px !important; height: 18px !important; margin-left: -6px;");
});

test("the rail scrolls with no visible scrollbar and keeps its row spacing", () => {
  for (const declaration of ["padding: 20px 16px;", "gap: 4px;", "overflow-y: auto;", "scrollbar-width: none;"]) has(find(shell, ".rail"), declaration);
  assert.equal(find(shell, ".rail::-webkit-scrollbar"), "display: none;");
  has(find(shell, ".rail > *"), "flex-shrink: 0;");
  assert.equal(find(shell, ".rail .navItem"), "height: 42px; gap: 12px; border-radius: 11px; font-size: 15px; font-weight: 500; line-height: 20px; color: var(--muted);");
  assert.equal(find(shell, ".railSpacer"), "flex: 1 0 34px;");
  for (const gone of [".bal", ".cashRows", ".cashAdd", ".cashActs", ".fold", ".eye"]) assert.ok(!shell.some((rule) => rule.selector.split(/[ ,:]/).includes(gone)), gone);
});

test("a window 760px tall or less uses 40px rail rows, 13px padding, and a 21px spacer", () => {
  const short = "(max-height: 760px)";
  assert.equal(find(shell, ".rail", short), "padding-block: 13px;");
  assert.equal(find(shell, ".railTop", short), "margin-bottom: 13px;");
  assert.equal(find(shell, ".rail .navItem", short), "height: 40px;");
  assert.equal(find(shell, ".railSpacer", short), "flex-basis: 21px;");
});

test("the account menu ends in an 18px faint chevron", () => {
  assert.equal(find(shell, ".mitem.acctMe > svg:last-child"), "width: 18px; height: 18px; color: var(--faint); flex: none;");
});

test("Mobile board (#594): a visitor's top bar stays one 52px row at 320px: Sign in takes the chip's 12px sides, flush after the bell", () => {
  has(find(shell, ".shell .topbar .topbarSignin:global(.btn)", "(max-width: 360px)"), "margin-left: 0; padding-inline: 12px;");
  // The service-status icon takes another 44px: the wordmark gives way, so the row still fits.
  has(find(shell, '.shell .topbar:has([aria-label^="Service status"]) .brand b', "(max-width: 360px)"), "display: none;");
});
