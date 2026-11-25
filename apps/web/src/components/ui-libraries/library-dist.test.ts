import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * OA-28's libraries, read as shipped (`docs/product/social-feed/ui-libraries.md`
 * §CSP): every file of every package they bring (their dependency closure in
 * `package-lock.json`, without React itself). The CSP allows no `eval`, no
 * un-nonced `<style>` and no other origin, so an upgrade that adds any of
 * them fails here and is reviewed before it ships.
 */

// The repository root: its one package-lock.json and the node_modules npm hoists there.
const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

/** The packages `package.json` names for OA-28 (the libraries and the dnd kit plugin package the provider imports). */
const LIBRARIES = [
  "@base-ui/react",
  "@dnd-kit/dom",
  "@dnd-kit/react",
  "clsx",
  "lightweight-charts",
  "motion",
  "react-virtuoso",
  "sonner",
  "zustand",
] as const;

/** The app's own React, and type-only packages: not shipped by these libraries. */
const NOT_THEIRS = /^(react|react-dom|scheduler|csstype|@types\/.*)$/;

type LockEntry = Readonly<{ dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }>;
const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8")) as { packages: Record<string, LockEntry> };

/** npm's resolution: the nearest `node_modules/<name>` from the requiring package up to the root. */
function resolve(from: string, name: string): string | null {
  let base = from;
  for (;;) {
    const candidate = `${base ? `${base}/` : ""}node_modules/${name}`;
    if (lock.packages[candidate]) return candidate;
    if (!base) return null;
    const at = base.lastIndexOf("/node_modules/");
    base = at < 0 ? "" : base.slice(0, at);
  }
}

function dependencyClosure(): string[] {
  const seen = new Set<string>();
  const queue = LIBRARIES.map((name) => `node_modules/${name}`);
  while (queue.length) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const entry = lock.packages[path] ?? {};
    for (const name of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies })) {
      if (NOT_THEIRS.test(name)) continue;
      const target = resolve(path, name);
      if (target) queue.push(target);
    }
  }
  return [...seen].sort();
}

function* scripts(directory: string): Generator<string> {
  for (const name of readdirSync(directory)) {
    if (name === "node_modules") continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) yield* scripts(path);
    else if (/\.(c|m)?js$/.test(name)) yield path;
  }
}

const PATTERNS = {
  eval: /(?<![\w$.])eval\s*\(|(?<![\w$.])Function\s*\(\s*["'`]|new Function\s*\(/,
  remote: /(?:fetch|import)\s*\(\s*["'`]https?:\/\/|\.src\s*=\s*["'`]https?:\/\//,
  styleElement: /createElement\(\s*["']style["']|jsxs?\(\s*["']style["']/,
  styleAttribute: /setAttribute\(\s*["']style["']/,
  styleSheet: /adoptedStyleSheets|new CSSStyleSheet|insertRule\(/,
} as const;

type Finding = Readonly<{ pattern: keyof typeof PATTERNS; pkg: string; file: string }>;

function scan(): { packages: string[]; findings: Finding[] } {
  const packages = dependencyClosure();
  const findings: Finding[] = [];
  for (const path of packages) {
    const directory = join(ROOT, path);
    if (!existsSync(directory)) continue;
    const pkg = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    for (const file of scripts(directory)) {
      const source = readFileSync(file, "utf8");
      for (const [pattern, regex] of Object.entries(PATTERNS) as [keyof typeof PATTERNS, RegExp][]) {
        if (regex.test(source)) findings.push({ pattern, pkg, file: file.slice(directory.length + 1) });
      }
    }
  }
  return { packages, findings };
}

const { packages, findings } = scan();

test("OA-28: the scan covers each library and what it brings", () => {
  for (const name of LIBRARIES) assert.ok(packages.includes(`node_modules/${name}`), name);
  // Chart canvas sizing, the drag engine and motion's DOM layer are included.
  for (const name of ["fancy-canvas", "@dnd-kit/abstract", "motion-dom"]) {
    assert.ok(packages.some((path) => path.endsWith(`node_modules/${name}`)), name);
  }
});

test("OA-28: no library evaluates strings as code (script-src has no 'unsafe-eval')", () => {
  const hits = findings.filter((finding) => finding.pattern === "eval");
  // Regenerator uses this fallback only in runtimes without globalThis.
  assert.deepEqual(hits, [{ pattern: "eval", pkg: "@babel/runtime", file: "regenerator/index.js" }]);
});

test("OA-28: no library loads code or styles from another origin", () => {
  assert.deepEqual(findings.filter((finding) => finding.pattern === "remote"), []);
});

test("OA-28: no library writes a style attribute through setAttribute (the CSP refuses it; the CSSOM is allowed)", () => {
  assert.deepEqual(findings.filter((finding) => finding.pattern === "styleAttribute"), []);
});

/**
 * Every package that writes a `<style>` or a constructed sheet, and how the
 * app keeps it within `style-src 'self' 'nonce-…'`. A new one fails this test.
 */
const STYLE_WRITERS: Readonly<Record<string, string>> = {
  "lightweight-charts": "Built-in attributionLogo injects a nonced-less style. Shared TradingViewChart disables it and provides static-CSS attribution links instead.",
  "@base-ui/react": "ScrollArea and Select's <style precedence>: LibraryProviders sets disableStyleElements; library-csp.css carries the rule",
  "@base-ui/utils": "StoreInspector, a development inspector no component imports",
  "@dnd-kit/dom": "StyleInjector's drag rules: ui-libraries/DragDropProvider configures it with the nonce",
  "framer-motion": "AnimatePresence popLayout's <style>: MotionConfig's nonce (LibraryProviders); AnimateView's is un-nonced, so it is not used",
  "motion": "the same code as framer-motion, in its UMD bundles",
  "motion-dom": "animateView's view-transition <style>, un-nonced: not used (ui-libraries.md, motion)",
  sonner: "an un-nonced <style> when the module loads: allowed by its hash (OA-30, SONNER_STYLE_HASHES in browser-policy.ts; style-hashes.test.ts hashes this copy)",
};

test("OA-28: every package that writes a <style> or a stylesheet is accounted for", () => {
  const writers = [
    ...new Set(
      findings
        .filter((finding) => finding.pattern === "styleElement" || finding.pattern === "styleSheet")
        .map((finding) => finding.pkg),
    ),
  ].sort();
  assert.deepEqual(writers, Object.keys(STYLE_WRITERS).sort());
});
