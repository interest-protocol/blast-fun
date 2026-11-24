import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "@typescript/typescript6";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const webRoot = join(repositoryRoot, "apps/web");
const sourceRoots = ["apps/web/src", "apps/workers/src", "packages/core/src"].map((path) => join(repositoryRoot, path));

function filesIn(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesIn(path) : [path];
  });
}

function importSpecifier(node: ts.Node): string | undefined {
  if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) return node.moduleSpecifier.text;
  if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) return node.moduleSpecifier.text;
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) return node.arguments[0].text;
  return undefined;
}

const runtimeFiles = sourceRoots.flatMap(filesIn).filter((path) => /\.[jt]sx?$/.test(path) && !/\.test\.|\.integration\.|\.d\.ts$/.test(path));

test("application and worker sources contain no developer routes or test fixtures", () => {
  assert.equal(existsSync(join(webRoot, "src/app/dev")), false);
  assert.equal(existsSync(join(webRoot, "src/app/(launchpad)/dev")), false);
  const leaks: string[] = [];
  for (const path of runtimeFiles) {
    const name = relative(repositoryRoot, path);
    if (/(?:fixture|harness|test-helpers|\/testing\.|\.testing\.)/i.test(name)) leaks.push(name);
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      const specifier = importSpecifier(node);
      if (specifier) {
        const target = specifier.startsWith(".") ? resolve(dirname(path), specifier) : specifier;
        if (/(?:^|\/)test(?:\/|$)|fixture|harness|test-helpers/i.test(target)) leaks.push(`${name}: ${specifier}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.deepEqual(leaks, []);
});

test("production artifacts exclude test fixtures and developer routes", { skip: process.env.CHECK_PRODUCTION_BUILD !== "1" }, () => {
  const buildRoot = join(webRoot, ".next");
  assert.ok(existsSync(join(buildRoot, "BUILD_ID")), "run a clean production build first");
  const manifest = JSON.parse(readFileSync(join(buildRoot, "server/app-paths-manifest.json"), "utf8")) as Record<string, string>;
  assert.deepEqual(Object.keys(manifest).filter((path) => path.includes("/dev/")), []);
  const fixturePaths = ["apps/web/test", "packages/core/test", "apps/workers/test"].flatMap((path) => filesIn(join(repositoryRoot, path))).map((path) => relative(repositoryRoot, path));
  const leaks = filesIn(join(buildRoot, "server")).filter((path) => /\.js\.map$|client-reference-manifest\.js$|\.nft\.json$/.test(path)).flatMap((path) => {
    const content = readFileSync(path, "utf8");
    return fixturePaths.filter((fixture) => content.includes(fixture)).map((fixture) => `${relative(buildRoot, path)}: ${fixture}`);
  });
  assert.deepEqual(leaks, []);
});
