import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The site shell cannot mount or restore Blast Mode. Within the workspace, the
 * approved Feed and coin Posts adapters are the only modules that render posts.
 */

const SRC = fileURLToPath(new URL("../../../", import.meta.url));
const MODE = fileURLToPath(new URL("./", import.meta.url));

function files(dir: string, keep: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...files(path, keep));
    else if (keep(path)) out.push(path);
  }
  return out;
}

const isCode = (path: string) => /\.(ts|tsx)$/.test(path);
const isTest = (path: string) => /\.test\.tsx?$/.test(path);

/** Every module specifier a file imports, re-exports or loads. */
function specifiers(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/(?:^|[\s;])(?:import|export)\s[^'"`;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|^import\s*["']([^"']+)["']/gm)) {
    out.push(match[1] ?? match[2] ?? match[3]!);
  }
  return out;
}

/** Resolves a project specifier as the bundler does (`#web/` and relative, extensionless); null for a package. */
function resolve(specifier: string, from: string): string | null {
  const base = specifier.startsWith("#web/scripts/") ? join(SRC, "..", "scripts", specifier.slice("#web/scripts/".length))
    : specifier.startsWith("#web/") ? join(SRC, specifier.slice("#web/".length)) : specifier.startsWith(".") ? join(dirname(from), specifier) : null;
  if (base === null) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && !statSync(candidate).isDirectory()) return candidate;
  }
  return null;
}

/** Every project module `entries` reach through static and dynamic imports. */
function graph(entries: readonly string[], follow: (from: string, target: string) => boolean = () => true): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!isCode(file)) continue;
    for (const specifier of specifiers(readFileSync(file, "utf8"))) {
      const target = resolve(specifier, file);
      if (target !== null && follow(file, target) && !seen.has(target)) queue.push(target);
    }
  }
  return seen;
}

test("the site shell cannot mount or restore Blast Mode", () => {
  assert.equal(resolve("#web/scripts/codemods/clsx-core.ts", join(SRC, "components/x.tsx")), join(SRC, "..", "scripts/codemods/clsx-core.ts"));
  const home = graph([join(SRC, "app/(app)/(social)/feed/page.tsx"), join(SRC, "app/(app)/layout.tsx")]);
  assert.ok(home.has(join(SRC, "components/social/coin-home/CoinHome.tsx")));
  const shell = graph([join(SRC, "app/(app)/layout.tsx")]);
  for (const entry of ["BlastModeHost.tsx", "workspace/WorkspaceHost.tsx", "workspace/WorkspaceRestoreCover.tsx"]) {
    assert.equal(shell.has(join(MODE, entry)), false, entry);
  }
  for (const path of home) assert.doesNotMatch(relative(SRC, path), /Fixture|fixtures/, "no fixture on Home");
});

function approvedWorkspacePostCard(from: string, target: string): boolean {
  return target === join(SRC, "components/social/post/PostCard.tsx")
    && [join(MODE, "workspace/FeedData.tsx"), join(MODE, "workspace/panels/CoinPosts.tsx")].includes(from);
}

function outsideWorkspaceGraph(entries: readonly string[]): Set<string> {
  // Modules outside the workspace share its assembly entry. Its workspace
  // composition is guarded separately; no other traversal edge is excluded.
  return graph(entries, (from) => from !== join(MODE, "BlastModeHost.tsx"));
}

test("workspace post rendering exceptions identify only the two approved PostCard edges", () => {
  const postCard = join(SRC, "components/social/post/PostCard.tsx");
  for (const adapter of ["workspace/FeedData.tsx", "workspace/panels/CoinPosts.tsx"]) {
    assert.equal(approvedWorkspacePostCard(join(MODE, adapter), postCard), true);
    assert.equal(approvedWorkspacePostCard(join(MODE, adapter), join(SRC, "components/social/post/PostPage.tsx")), false);
  }
  for (const other of ["BlastModeHost.tsx", "workspace/WorkspaceHost.tsx", "workspace/panels/CoinPanel.tsx"]) {
    assert.equal(approvedWorkspacePostCard(join(MODE, other), postCard), false, other);
  }
});

test("the outside-workspace traversal still detects rendering through either workspace adapter", () => {
  for (const adapter of ["workspace/FeedData.tsx", "workspace/panels/CoinPosts.tsx"]) {
    assert.ok(outsideWorkspaceGraph([join(MODE, adapter)]).has(join(SRC, "components/social/post/PostCard.tsx")), adapter);
  }
});

test("AC-11: only approved workspace adapters render posts; modules outside the workspace reach no feed renderers", () => {
  const renderers = [
    "components/social/post/PostCard.tsx",
    "components/social/post/PostPage.tsx",
    "components/social/post/CallCard.tsx",
    "components/social/FeedList.tsx",
  ];
  for (const path of files(MODE, (each) => isCode(each) && !isTest(each))) {
    for (const specifier of specifiers(readFileSync(path, "utf8"))) {
      const target = resolve(specifier, path);
      if (target === null) continue;
      assert.ok(approvedWorkspacePostCard(path, target) || !renderers.includes(relative(SRC, target)), `${relative(SRC, path)} imports ${relative(SRC, target)}`);
    }
  }
  const modules = files(MODE, (each) => isCode(each) && !isTest(each) && !/Fixture|fixtures/.test(each));
  // Cut only the approved edges, so another workspace path to a renderer still fails.
  const mode = graph(modules, (from, target) => !approvedWorkspacePostCard(from, target));
  for (const renderer of renderers) assert.equal(mode.has(join(SRC, renderer)), false, `Blast mode reaches ${renderer}`);
  // Every non-workspace module is a root; the shared lifecycle entry is the
  // sole assembly boundary. Their imports of FeedData remain forbidden.
  const outside = outsideWorkspaceGraph(modules.filter((path) => !path.startsWith(join(MODE, "workspace") + "/")));
  for (const renderer of renderers) assert.equal(outside.has(join(SRC, renderer)), false, `Blast mode outside the workspace reaches ${renderer}`);
});
