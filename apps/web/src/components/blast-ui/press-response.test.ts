import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * OA-31 (the gate's version 5): every control answers on the way down, and a
 * reader who asked for less motion gets a dip instead of a scale — "under
 * reduced motion a press is `transform: none; opacity: .7`" (Blast mode's own
 * controls keep the gate's `.75`). The computed values need a browser; this
 * pins the source of every Blast UI stylesheet, so a new scaled press without
 * its fallback fails here rather than in a reader's hand.
 */
const COMPONENTS = fileURLToPath(new URL("..", import.meta.url));
const ROOTS = ["blast-ui", "social", "presale-pages", "sign-in"].map((dir) => join(COMPONENTS, dir));

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return name.endsWith(".css") ? [path] : [];
  });
}

type Rule = Readonly<{ media: string; selector: string; body: string }>;

function blockEnd(text: string, open: number): number {
  let depth = 1;
  let close = open + 1;
  while (depth > 0) {
    if (text[close] === "{") depth += 1;
    else if (text[close] === "}") depth -= 1;
    close += 1;
  }
  return close;
}

/** Top-level rules and the rules one `@media` deep (the depth these stylesheets use). */
function rules(css: string): Rule[] {
  const out: Rule[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let index = 0;
  const block = (media: string, end: number) => {
    while (index < end) {
      const open = text.indexOf("{", index);
      if (open < 0 || open >= end) return;
      const head = text.slice(index, open).trim();
      if (head.startsWith("@")) {
        const close = blockEnd(text, open);
        // Conditional groups hold rules; `@keyframes` holds frames, which are not rules.
        if (!head.startsWith("@keyframes")) {
          index = open + 1;
          block(head, close - 1);
        }
        index = close;
        continue;
      }
      const close = text.indexOf("}", open);
      out.push({ media, selector: head.replace(/\s+/g, " "), body: text.slice(open + 1, close) });
      index = close + 1;
    }
  };
  block("", text.length);
  return out;
}

/** Splits a selector list at its top-level commas. */
function split(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === "(") depth += 1;
    else if (list[i] === ")") depth -= 1;
    else if (list[i] === "," && depth === 0) {
      parts.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(list.slice(start).trim());
  return parts;
}

/** One selector as a comparable key: `:is(a, b)` expanded, every `:not(…)` dropped. */
function keys(selector: string): string[] {
  const is = selector.indexOf(":is(");
  if (is >= 0) {
    const [inner, end] = argument(selector, is);
    return split(inner).flatMap((option) => keys(`${selector.slice(0, is)}${option}${selector.slice(end + 1)}`));
  }
  let out = selector;
  for (let not = out.indexOf(":not("); not >= 0; not = out.indexOf(":not(")) {
    const [, end] = argument(out, not);
    out = out.slice(0, not) + out.slice(end + 1);
  }
  return [out.replace(/\s+/g, " ").trim()];
}

/** The argument of the pseudo-class opening at `at` (`:is(`, `:not(`, …) and the index of its closing paren. */
function argument(selector: string, at: number): [string, number] {
  let depth = 0;
  let end = selector.indexOf("(", at);
  const open = end;
  for (; end < selector.length; end += 1) {
    if (selector[end] === "(") depth += 1;
    else if (selector[end] === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return [selector.slice(open + 1, end), end];
}

type Specificity = readonly [number, number, number];
const higher = (a: Specificity, b: Specificity) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** A selector's specificity: `:global()` is transparent, `:where()` weighs nothing, `:is()`/`:not()`/`:has()` their heaviest argument. */
function specificity(selector: string): Specificity {
  const total = [0, 0, 0];
  let rest = selector;
  for (let at = rest.search(/:(global|where|is|not|has)\(/); at >= 0; at = rest.search(/:(global|where|is|not|has)\(/)) {
    const name = /:(global|where|is|not|has)\(/.exec(rest.slice(at))![1];
    const [inner, end] = argument(rest, at);
    if (name === "global") {
      rest = rest.slice(0, at) + " " + inner + " " + rest.slice(end + 1);
      continue;
    }
    if (name !== "where") {
      const heaviest = split(inner).map(specificity).sort((a, b) => higher(b, a))[0]!;
      total[0] += heaviest[0];
      total[1] += heaviest[1];
      total[2] += heaviest[2];
    }
    rest = rest.slice(0, at) + rest.slice(end + 1);
  }
  rest = rest.replace(/\[[^\]]*\]/g, () => {
    total[1] += 1;
    return " ";
  });
  total[0] += (rest.match(/#[\w-]+/g) ?? []).length;
  total[1] += (rest.match(/\.[\w-]+/g) ?? []).length + (rest.match(/(?<!:):[\w-]+/g) ?? []).length;
  total[2] += (rest.match(/::[\w-]+/g) ?? []).length + (rest.match(/(?:^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
  return total as unknown as Specificity;
}

const REDUCED = /prefers-reduced-motion:\s*reduce/;
const sheets = ROOTS.flatMap(cssFiles).map((path) => ({ path, name: relative(COMPONENTS, path), rules: rules(readFileSync(path, "utf8")) }));

test("OA-31: every scaled press has a reduced-motion fallback that dips instead, and wins the cascade", () => {
  const missing: string[] = [];
  for (const sheet of sheets) {
    // Each fallback selector with its key, weight and place: it must outweigh the press, or match it and come later.
    const fallbacks = sheet.rules.flatMap((rule, index) =>
      REDUCED.test(rule.media) && /transform:\s*none/.test(rule.body) && /opacity:\s*\.7/.test(rule.body)
        ? split(rule.selector).flatMap((part) => keys(part).map((key) => ({ key, weight: specificity(part), index })))
        : [],
    );
    sheet.rules.forEach((rule, index) => {
      if (REDUCED.test(rule.media) || !/:active/.test(rule.selector) || !/transform:\s*scale\(|(?:^|;)\s*scale:\s*/.test(rule.body)) return;
      for (const part of split(rule.selector)) {
        const weight = specificity(part);
        for (const key of keys(part)) {
          if (!key.includes(":active")) continue;
          const wins = fallbacks.some((fallback) => fallback.key === key && (higher(fallback.weight, weight) > 0 || (higher(fallback.weight, weight) === 0 && fallback.index > index)));
          if (!wins) missing.push(`${sheet.name}: ${key}`);
        }
      }
    });
  }
  assert.deepEqual(missing, []);
});

test("the specificity reader agrees with the cascade on the cases this file relies on", () => {
  assert.deepEqual(specificity(".card:active:not(:has(button:active, a:active, .extra:active)) .face"), [0, 5, 0]);
  assert.deepEqual(specificity(":global([data-blast-ui]) :is(.backbar a, .sort):active"), [0, 3, 1]);
  assert.deepEqual(specificity(".tabbar a:active svg"), [0, 2, 2]);
  assert.deepEqual(specificity("button.total:active"), [0, 2, 1]);
  assert.deepEqual(specificity(".switch:active::after"), [0, 2, 1]);
});

/**
 * The shared control's blanket stop: under reduced motion no Button moves, whatever another module's
 * selector says (a dock chip's own scale on a shared Button), including keyboard (`:focus-visible`)
 * presses, which the dipping press in the next rule deliberately leaves alone and so must not dip.
 */
const BLANKET_STOP = "blast-ui/Controls.module.css: .button:active";

test("OA-31: a reduced-motion press never only cancels the scale (it dips: .7, or Blast mode's .75)", () => {
  const silent = sheets.flatMap((sheet) =>
    sheet.rules
      .filter((rule) => REDUCED.test(rule.media) && /:active/.test(rule.selector) && /transform:\s*none/.test(rule.body) && !/opacity:\s*\.75?;?/.test(rule.body))
      .map((rule) => `${sheet.name}: ${rule.selector}`),
  );
  assert.deepEqual(silent.filter((rule) => rule !== BLANKET_STOP), []);
  assert.ok(silent.includes(BLANKET_STOP), "the blanket stop is still there, so its exemption is still needed");
});

test("OA-31: the controls the press audit found still answer, by the gate's house rule", () => {
  const read = (name: string) => sheets.find((sheet) => sheet.name === name)!.rules;
  const press = (name: string, selector: string) => {
    const found = read(name).filter((rule) => !REDUCED.test(rule.media) && split(rule.selector).flatMap(keys).includes(selector));
    assert.ok(found.length > 0, `${name}: no press for ${selector}`);
    return found.map((rule) => rule.body).join(";");
  };
  // Pills, chips, icon buttons and shared buttons scale .97; a glyph alone (the rail's and tab bar's icons) .94, the same visible step.
  assert.match(press("social/post/RocketButton.module.css", ".rocket:active"), /scale\(\.97\)/);
  assert.match(press("social/post/PostCard.module.css", ".tchip:active"), /scale\(\.97\)/);
  assert.match(press("blast-ui/Controls.module.css", ".button:active"), /scale\(\.97\)/);
  assert.match(press("blast-ui/blast-ui.css", "[data-blast-ui] .icon-btn:active"), /scale\(\.97\)/);
  assert.match(press("blast-ui/AppShell.module.css", ".tabbar a:active svg"), /scale\(\.94\)/);
  assert.match(press("blast-ui/AppShell.module.css", ".navItem:active svg"), /scale\(\.94\)/);
  // The press snaps in and the release eases back on the base transition.
  assert.match(press("blast-ui/Controls.module.css", ".button:active"), /transition-duration:0s/);
  assert.match(press("blast-ui/blast-ui.css", "[data-blast-ui] .btn:active"), /transition-duration: 0s/);
  assert.match(press("presale-pages/presales.module.css", ":global([data-blast-ui]) a.srow2:active"), /scale\(\.99\)/);
  // Flush rows take --hair; a row that is already grey a step deeper.
  assert.match(press("blast-ui/AppShell.module.css", "a.mitem:active"), /background: var\(--hair\)/);
  assert.match(press("social/search/Search.module.css", ".item.kb:active"), /background: var\(--hair-2\)/);
  // Segmented controls dip.
  assert.match(press("blast-ui/blast-ui.css", "[data-blast-ui] .seg button:active"), /opacity: \.6/);
});

test("OA-31: only real controls press — rows reused on a div (a pending sale) and the disabled Create row stay still", () => {
  const selectors = sheets.flatMap((sheet) => sheet.rules.filter((rule) => /:active/.test(rule.selector)).map((rule) => `${sheet.name}: ${rule.selector}`));
  for (const bare of [/Profile\.module\.css: \.lrow:active/, /presales\.module\.css: .*\(\.lrow\b/]) {
    assert.ok(!selectors.some((selector) => bare.test(selector)), `unscoped row press ${bare}`);
  }
  const mitem = selectors.filter((selector) => selector.startsWith("blast-ui/AppShell.module.css") && selector.includes(".mitem"));
  assert.ok(mitem.length > 0 && mitem.every((selector) => selector.includes(':is(a, button).mitem:not([aria-disabled="true"])')), mitem.join("\n"));
});

test("#614: Blast mode modules leave a shared Button's press to the shared control", () => {
  // These classes sit on Button, IconButton or DisclosureButton; Controls.module.css owns their press (.97, a .7 dip under reduced motion).
  const shared = { "social/blast-mode/workspace/PanelDock.module.css": [".chip:active", ".layoutTrigger:active"], "social/blast-mode/workspace/TrackedPanels.module.css": [".iconButton:active", ".savedTrigger:active"], "social/blast-mode/workspace/panels/PanelChrome.module.css": [".tab:active"] } as const;
  for (const [name, selectors] of Object.entries(shared)) {
    const rules = sheets.find((sheet) => sheet.name === name)!.rules;
    for (const selector of selectors) {
      assert.deepEqual(rules.filter((rule) => split(rule.selector).flatMap(keys).includes(selector) && /transform|opacity/.test(rule.body)).map((rule) => rule.selector), [], `${name}: ${selector}`);
    }
  }
});
