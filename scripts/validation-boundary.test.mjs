import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const toolingScripts = new Set(["apps/web/scripts/partner-api-live/check.mjs"]);

const root = fileURLToPath(new URL("../", import.meta.url));
const toolingFiles = new Set([
  "packages/core/src/modules/presale/contracts/validate.ts",
  "packages/core/src/modules/presale/contracts/schema-branches.ts",
  "packages/core/src/modules/social/contracts/validate.ts",
]);

function isToolingImport(specifier, file) {
  if (/^ajv(?:[-/]|$)/.test(specifier)) return true;
  const target = specifier.startsWith(".")
    ? relative(root, resolve(dirname(resolve(root, file)), specifier))
    : specifier
        .replace(/^@blast\/core\/web\/contracts\//, "@blast/core/modules/social/contracts/")
        .replace(/^@blast\/core\//, "packages/core/src/");
  return (
    toolingFiles.has(target.replace(/\.js$/, ".ts")) ||
    [...toolingFiles].some((tool) => target === tool.replace(/\.ts$/, ""))
  );
}

test("runtime source cannot import Ajv or JSON Schema tooling wrappers", () => {
  const violations = [];
  for (const file of globSync(
    [
      "apps/*/src/**/*.{ts,tsx,js,mjs}",
      "packages/*/src/**/*.{ts,tsx,js,mjs}",
      "apps/*/scripts/**/*.{ts,tsx,js,mjs}",
      "packages/*/scripts/**/*.{ts,tsx,js,mjs}",
      "scripts/*.{ts,js,mjs}",
    ],
    { cwd: root },
  )) {
    if (
      toolingFiles.has(file) ||
      toolingScripts.has(file) ||
      /\.(?:integration\.)?test\./.test(file)
    )
      continue;
    const source = ts.createSourceFile(
      file,
      readFileSync(resolve(root, file), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    function visit(node) {
      let specifier;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        specifier = node.moduleSpecifier;
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      )
        specifier = node.arguments[0];
      if (specifier && ts.isStringLiteralLike(specifier) && isToolingImport(specifier.text, file)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        violations.push(`${file}:${line + 1}: ${specifier.text}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.deepEqual(
    violations,
    [],
    "Use Zod in runtime code; Ajv and its wrappers belong in tests and tooling.",
  );
});
