import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "@typescript/typescript6";
import { transform } from "lightningcss";

const WEB_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const ROOTS = ["src/components/blast-ui", "src/components/social", "src/components/presale-pages"];

const sources = (directory: string): string[] =>
  readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });

type ModuleExports = Map<string, ReadonlySet<string>>;

function missingClassReferences(file: string, code: string, cache: ModuleExports): string[] {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest);
  const requireFromFile = createRequire(file);
  const imports = new Map<string, ReadonlySet<string>>();

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const from = statement.moduleSpecifier.text;
    const binding = statement.importClause;
    if (!from.endsWith(".module.css") || !binding?.name || binding.isTypeOnly) {
      continue;
    }
    const filename = requireFromFile.resolve(from);
    let names = cache.get(filename);
    if (!names) {
      const { exports } = transform({ filename, code: readFileSync(filename), cssModules: true });
      names = new Set(Object.keys(exports ?? {}));
      cache.set(filename, names);
    }
    imports.set(binding.name.text, names);
  }

  const missing = new Set<string>();
  function visit(node: ts.Node): void {
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        ts.isIdentifier(node.expression)) {
      const binding = node.expression.text;
      const names = imports.get(binding);
      const name = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;
      if (names && name !== undefined && !names.has(name)) {
        missing.add(`${relative(WEB_ROOT, file)}: ${binding}.${name}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  if (imports.size > 0) {
    visit(source);
  }
  return [...missing];
}

test("CSS module references must name an export from aliased or relative imports", () => {
  const file = fileURLToPath(import.meta.url);
  const cache: ModuleExports = new Map();
  for (const from of ["#web/components/social/post/PostCard.module.css", "../social/post/PostCard.module.css"]) {
    const code = `import post from "${from}"; [post.post, post.iconBtn, post["btn"]];`;
    assert.deepEqual(missingClassReferences(file, code, cache), [
      "src/components/blast-ui/css-module-classes.test.ts: post.iconBtn",
      "src/components/blast-ui/css-module-classes.test.ts: post.btn",
    ]);
  }
});

test("every statically named CSS module class read by a social-feed component is exported", () => {
  const cache: ModuleExports = new Map();
  const missing = ROOTS.flatMap((root) => sources(join(WEB_ROOT, root)))
    .flatMap((file) => missingClassReferences(file, readFileSync(file, "utf8"), cache));
  assert.deepEqual(missing, []);
});
