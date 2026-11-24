import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * One tooltip group for the app, so moving across prices shows the first tooltip after 180ms and the next ones at
 * once (Base UI's instant phase). The timing needs a browser; this pins the wiring, so a per-value provider, which
 * gives every value its own wait and entrance, fails here.
 */
const COMPONENTS = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : [];
  });
}

test("the shell mounts the one tooltip group, at 180ms with no close delay", () => {
  assert.match(read("./TooltipGroup.tsx"), /<Tooltip\.Provider delay=\{TOOLTIP_DELAY_MS\} closeDelay=\{0\}>/);
  assert.match(read("./TooltipGroup.tsx"), /TOOLTIP_DELAY_MS = 180;/);
  assert.match(read("./AppShell.tsx"), /<TooltipGroup>\s*<ShellFrame \{\.\.\.props\} \/>\s*<\/TooltipGroup>/);
});

test("no live component opens its own tooltip provider; triggers keep the 180ms wait without one", () => {
  const dead = /social\/blast-mode\/(lanes|ticker|dock|panel|timeline|rail|live|composer)\//;
  const providers = sources(COMPONENTS)
    .filter((path) => !dead.test(path) && !path.endsWith("TooltipGroup.tsx") && !path.includes("/ui-libraries/"))
    .filter((path) => /<Tooltip\.Provider\b/.test(readFileSync(path, "utf8")));
  assert.deepEqual(providers, []);
  assert.match(read("./InspectValue.tsx"), /delay=\{TOOLTIP_DELAY_MS\}/);
});

test("a tooltip opened in the group's instant phase has no entrance; the trigger answers a mouse press", () => {
  const css = read("./InspectValue.module.css");
  assert.match(css, /\.tip\[data-instant\] \{\s*transition: none;\s*\}/);
  assert.match(css, /@media \(hover: hover\) and \(pointer: fine\) \{[^@]*\.trigger:active \{\s*transform: scale\(\.97\);/);
  assert.match(read("./ServiceStatus.module.css"), /@media \(hover: hover\) and \(pointer: fine\) \{[^@]*\.trigger:active \{ transform: scale\(\.97\);/);
});
