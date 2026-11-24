import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * The 2026-10-05 visual check against the OA-24 gate
 * (`design/blast-feel-preview-oa24.html`, sha256 232e34aa…3017f0a), headless
 * Chrome with classic scrollbars. Each rule below closed a measured gap; the
 * remaining rules pin their separate source contracts. KA-5 labels now run
 * in verify-shell-typography.mjs with the real shell and loaded fonts (#799).
 */
const RULE = /([^{}]*)\{([^{}]*)\}/g;
const rules = (path: string) =>
  [...readFileSync(new URL(path, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").matchAll(RULE)].map(
    ([, selector, body]) => [selector!.trim().replace(/\s+/g, " "), body!] as const,
  );
const base = rules("./blast-ui.css");
const shell = rules("./AppShell.module.css");
const body = (list: typeof base, selector: string) => {
  const found = list.find(([candidate]) => candidate === selector);
  assert.ok(found, `no rule ${selector}`);
  return found[1];
};
const token = (selector: string, name: string) => body(base, selector).match(new RegExp(`${name}: (#[0-9a-f]{6})`))![1];

test("SHELL-1: the document's scrollbar is the gate's thin one, in each theme's --hair-2", () => {
  const light = token("[data-blast-ui]", "--hair-2");
  const dark = token('[data-blast-ui][data-theme="dark"]', "--hair-2");
  assert.equal(token('[data-blast-ui]:not([data-theme="light"])', "--hair-2"), dark);
  const root = body(base, "html:has(> body > [data-blast-ui]), html:has(> body > [data-blast-ui]) > body");
  assert.match(root, /scrollbar-width: thin;/);
  assert.match(root, new RegExp(`scrollbar-color: ${light} transparent;`));
  for (const selector of [
    'html:has(> body > [data-blast-ui]:not([data-theme="light"])), html:has(> body > [data-blast-ui]:not([data-theme="light"])) > body',
    'html:has(> body > [data-blast-ui][data-theme="dark"]), html:has(> body > [data-blast-ui][data-theme="dark"]) > body',
  ]) {
    assert.match(body(base, selector), new RegExp(`scrollbar-color: ${dark} transparent;`), selector);
  }
});

test("FOCUS-1: main, focused from script when Blast mode closes, draws no ring, and the rule follows the shared ring so it wins", () => {
  const selectors = base.map(([selector]) => selector);
  const ring = selectors.findIndex((selector) => selector.startsWith("[data-blast-ui] :is(button, a, [tabindex])"));
  const main = selectors.indexOf('[data-blast-ui] main[tabindex="-1"]:focus-visible');
  assert.ok(ring >= 0 && main > ring, "the main rule comes after the shared focus ring");
  assert.match(body(base, '[data-blast-ui] main[tabindex="-1"]:focus-visible'), /box-shadow: none;/);
});

test("BM-7: the reserved gutter has the gate's `html` specificity, so Blast mode's release of it wins", () => {
  const gutter = base.filter(([, declarations]) => /scrollbar-gutter:/.test(declarations));
  assert.deepEqual(gutter.map(([selector]) => selector), ["html:where(:has(> body > [data-blast-ui]))"]);
  assert.match(gutter[0]![1], /scrollbar-gutter: stable;/);
  // The workspace (Blast mode's only screen) releases it while its frame is open.
  const workspace = rules("../social/blast-mode/workspace/WorkspaceHost.module.css");
  assert.match(body(workspace, ":global(html):has(.frame:is([data-workspace-host],[data-workspace-boot]))"), /overflow:\s*hidden;\s*scrollbar-gutter:\s*auto;/);
});


test("SHELL-2/SHELL-4 (OA-25 Q2, OA-41): the collapsed rail shows no balances, and no card or pill is left", () => {
  assert.ok(!shell.some(([selector]) => /\.(balMini|balRow|foldMini|foldFull|fold|bal)\b/.test(selector)));
});

test("SIGN-1: a sheet's lead wraps `pretty` like the gate's `.sheet .lead`; its title still balances", () => {
  const sheet = rules("./Sheet.module.css");
  assert.match(body(sheet, ".lead"), /text-wrap: pretty;/);
  assert.match(body(sheet, ".title"), /text-wrap: balance;/);
  // The coins sheet's head (the gate's `coinHead`: a coin, Deposit, Withdraw) is a `.sheet .lead` too.
  const coins = rules("../social/coins/coins.module.css");
  assert.match(body(coins, ".lead"), /text-wrap: pretty;/);
  assert.match(body(coins, ".head h2"), /text-wrap: balance;/);
});
