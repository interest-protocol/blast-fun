import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Source guards for the live layer (R3-60).
 *
 * - AC-1: a price tick never recolours the number: no keyframes anywhere in
 *   Blast mode animate `color` (the tint animates `background-color` only).
 * - AC-10 and §22.2: nothing invents data — no price walk, no commit
 *   simulation, no tape loop, no "last hour" counter, no demo hook — and
 *   only the bounded account-save recovery backoff draws a random number.
 * - AC-8 and §22.1 defect 22: Blast mode starts no timer, interval or frame
 *   of its own, except the exact independently owned workspace sites below.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function files(dir: string, keep: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...files(path, keep));
    else if (keep(path)) out.push(path);
  }
  return out;
}

const isSource = (path: string) => /\.(ts|tsx)$/.test(path) && !/\.test\.tsx?$/.test(path);
/** The entry points (the shell's action and its 480 ms arrival from another page) run before the mode opens; they are not the mode. */
const isModeModule = (path: string) => !/blast-mode-store\.ts$|BlastModeHost\.tsx$/.test(path);

test("AC-1: no keyframes in Blast mode recolour text; the tint animates the background only", () => {
  for (const path of files(ROOT, (each) => each.endsWith(".css"))) {
    const css = readFileSync(path, "utf8");
    for (const block of css.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/g)) {
      assert.doesNotMatch(block[2]!, /(^|[;{\s])color\s*:/, `${relative(ROOT, path)} @keyframes ${block[1]} changes a colour`);
    }
  }
});

function assertNoSyntheticData(name: string, source: string) {
  // Account recovery jitter is required; every other random expression stays forbidden, including in this file.
  const checked = name === "workspace/account-sync.ts"
    ? source.replace(/const backoff =\s*Math\.min\(30_000, 1000 \* 2 \*\* attempts\) \* \(0\.75 \+ Math\.random\(\) \* 0\.5\);(?=\s*outbox\.retry_not_before_ms =)/, "")
    : source;
  assert.doesNotMatch(checked, /Math\.random/, `${name} draws a random number outside bounded recovery jitter`);
  assert.doesNotMatch(source, /\b(bxPriceLoop|pxTick|pxSeed|gauss|tapeLoop|tapePush|applyCommit|lastHour|BX_DEMO|bxDemo)\b/, `${name} names a prototype-only loop`);
}

test("AC-10: no synthetic prices, tape, commits or demo hooks; only bounded account recovery jitter may draw randomness", () => {
  for (const path of files(ROOT, isSource)) {
    const source = readFileSync(path, "utf8");
    const name = relative(ROOT, path);
    assertNoSyntheticData(name, source);
  }
});

test("AC-10: the jitter allowance rejects extra financial randomness, unbounded jitter and prototype hooks even in workspace", () => {
  const recovery = readFileSync(join(ROOT, "workspace", "account-sync.ts"), "utf8");
  assert.doesNotThrow(() => assertNoSyntheticData("workspace/account-sync.ts", recovery));
  assert.throws(() => assertNoSyntheticData("workspace/account-sync.ts", `${recovery}\nconst price = Math.random();`), /outside bounded recovery jitter/);
  assert.throws(() => assertNoSyntheticData("workspace/account-sync.ts", recovery.replace("Math.random() * 0.5", "Math.random() * 50")), /outside bounded recovery jitter/);
  assert.throws(() => assertNoSyntheticData("workspace/market.ts", recovery), /outside bounded recovery jitter/);
  assert.throws(() => assertNoSyntheticData("workspace/account-sync.ts", `${recovery}\napplyCommit();`), /prototype-only loop/);
});

const WORKSPACE_SCHEDULERS = new Map<string, readonly Readonly<{ expression: string; reason: string }>[]>([
  ["workspace/WorkspaceHost.tsx", [
    {
      expression: "window.requestAnimationFrame(() => { (collapsed ? dataExpandTrigger.current : dataCollapseTrigger.current )?.focus({ preventScroll: true }); });",
      reason: "one user-event frame restores focus between the Data collapse and expand controls",
    },
    {
      expression: `window.requestAnimationFrame(() => (document.querySelector<HTMLElement>('#workspace-data input[type="search"]') ?? document.querySelector<HTMLElement>('#workspace-data [role="tab"][aria-selected="true"]'))?.focus());`,
      reason: "one user-event frame focuses the revealed Data search, or its selected view tab, after Add",
    },
    {
      expression: `window.requestAnimationFrame(() => { const trigger = presaleTriggerRef.current; if (trigger?.isConnected && !trigger.closest("[hidden],[inert]")) trigger.focus({ preventScroll: true }); });`,
      reason: "one user-event frame returns focus to the control that opened presale context",
    },
    {
      expression: "window.requestAnimationFrame(() => previous.element?.isConnected && previous.element.focus({preventScroll:true}));",
      reason: "one user-event frame returns focus to the control that began a cancelled Add",
    },
    {
      expression: "requestAnimationFrame(() => workspace.dataExpandTrigger.current?.focus());",
      reason: "one user-event frame focuses Data after the mobile workspace reveals it",
    },
  ]],
  ["workspace/WorkspaceUndo.tsx", [{
    expression: "const timeout = setTimeout(() => expire(), remaining.current);",
    reason: "Undo owns one six-second dismissal timeout, pauses on hover or focus, and clears it on effect cleanup",
  }]],
  ["workspace/CoinsData.tsx", [{
    expression: "requestAnimationFrame(() => region.current?.focus({ preventScroll: true }));",
    reason: "one user-event frame focuses the ecosystem region the Ecosystem pill reveals",
  }]],
  ["workspace/account-sync.ts", [{
    expression: "timer = setTimeout( () => { void dispatch(); }, Math.max( 0, Math.max(editDue, outbox.retry_not_before_ms ?? 0) - Date.now(), ), );",
    reason: "account schedule replaces its one debounce/retry timeout; dispose clears it and forbids rescheduling",
  }]],
  ["workspace/live-read.ts", [{
    expression: "after: (run, ms) => setTimeout(run, ms),",
    reason: "the injectable live clock; the active read effect's disposer aborts and clears its one wait",
  }]],
  ["workspace/WorkspaceSaveStatus.tsx", [{
    expression: "const timeout = setTimeout(() => setSlow(true), SLOW_SAVE_MS);",
    reason: "a pending save owns one 1.5s delay before its spinner shows (audit 03); finishing, failing and unmount clear it",
  }]],
  ["workspace/panels/CoinFocusContext.tsx", [{
    expression: `frame = requestAnimationFrame(() => document.getElementById(contextTabId(id, "portfolio"))?.focus({ preventScroll: true }));`,
    reason: "the portfolio action focuses its selected tab; superseding events and cleanup cancel the frame",
  }]],
  ["workspace/panels/TradingViewPlot.tsx", [{
    expression: "return requestAnimationFrame(place);",
    reason: "one frame places the inspected crosshair after panning; a new selection and disposal cancel it",
  }]],
  ["workspace/workspace-search.ts", [{
    expression: 'requestAnimationFrame(() => document.querySelector<HTMLInputElement>(\'#workspace-data input[type="search"]\')?.focus());',
    reason: "one user-event frame focuses the revealed workspace search field",
  }]],
]);

function assertRegisteredScheduling(name: string, source: string) {
  let checked = source.replace(/\s+/g, " ");
  for (const site of WORKSPACE_SCHEDULERS.get(name) ?? []) {
    assert.equal(checked.split(site.expression).length - 1, 1, `${name}: expected exactly one registered expression (${site.reason})`);
    checked = checked.replace(site.expression, "");
  }
  const raw = checked.match(/\b(window\.)?(setInterval|setTimeout|requestAnimationFrame)\s*\(/g) ?? [];
  assert.equal(raw.length, 0, `${name} schedules outside the registry: ${raw.join(", ")}`);
}

test("AC-8: Blast mode schedules nothing of its own outside the explicitly owned workspace sites", () => {
  for (const path of files(ROOT, (each) => isSource(each) && isModeModule(each))) {
    assertRegisteredScheduling(relative(ROOT, path), readFileSync(path, "utf8"));
  }
});

test("AC-8: registered workspace sites reject extra, duplicated or changed scheduling and unknown workspace files", () => {
  for (const [name, sites] of WORKSPACE_SCHEDULERS) {
    const source = readFileSync(join(ROOT, name), "utf8");
    assert.doesNotThrow(() => assertRegisteredScheduling(name, source));
    for (const scheduler of ["setTimeout", "setInterval", "requestAnimationFrame"]) {
      assert.throws(() => assertRegisteredScheduling(name, `${source}\n${scheduler}(() => {}, 1);`), /schedules outside the registry/);
      assert.throws(() => assertRegisteredScheduling("workspace/unregistered.ts", `${scheduler}(() => {}, 1);`), /schedules outside the registry/);
    }
    for (const site of sites) {
      assert.throws(() => assertRegisteredScheduling(name, `${source}\n${site.expression}`), /expected exactly one registered expression/);
      assert.throws(() => assertRegisteredScheduling(name, source.replace(/\b(setTimeout|requestAnimationFrame)\(/, "setInterval(")), /expected exactly one registered expression/);
    }
  }
});
