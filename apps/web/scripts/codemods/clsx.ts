// OA-28 M6: conditional classNames → clsx, as a codemod that can be run again
// on a newer tree (it converts what is left and changes nothing it already did).
//
//   node --no-warnings --experimental-strip-types scripts/codemods/clsx.ts            # dry run: what would change
//   node --no-warnings --experimental-strip-types scripts/codemods/clsx.ts --write    # convert, and record the shapes
//   node --no-warnings --experimental-strip-types scripts/codemods/clsx.ts --record   # dry run that records the shapes only
//   node --no-warnings --experimental-strip-types scripts/codemods/clsx.ts --check    # exit 1 while a site is left
//
// Options: --report <file.json> (every site, converted or skipped, with the
// reason), --shapes <file.json> (default scripts/codemods/clsx-shapes.json; the
// distinct shapes, merged with the ones already recorded, which
// src/components/ui-libraries/clsx-equivalence.test.ts replays), --root <dir>,
// and file paths to limit the run.
//
// What it converts, in the Blast UI and social surfaces (src/components and
// src/app, not the launchpad or Mission Control): a `className` (attribute,
// property or `…Class`/`classes` variable) written as a template literal,
// `[…].filter(Boolean).join(" ")`, `[…].join(" ")`, or a ternary between such
// lists. It writes `clsx(…)`, and adds `import clsx from "clsx";`. A site
// converts only when the type checker proves each value prints the same
// classes in the same order (a CSS-module class must exist in its stylesheet);
// anything else is reported as skipped, with the reason, and left as it was.
// The scoped `cx` mappers (presale-pages, social/create) keep their calls;
// their argument shapes are recorded for the same test.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { mergeShapes, runCodemod, type CxShape, type Shape, type Site } from "./clsx-core.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string): string | null => {
  const at = args.indexOf(name);
  return at >= 0 && at + 1 < args.length ? args[at + 1]! : null;
};
const root = path.resolve(option("--root") ?? process.cwd());
const valued = new Set(["--report", "--shapes", "--root"]);
const paths = args.filter((arg, index) => !arg.startsWith("--") && !valued.has(args[index - 1] ?? ""));
const write = flag("--write");
const record = write || flag("--record");
const check = flag("--check");
const shapesFile = path.resolve(root, option("--shapes") ?? "scripts/codemods/clsx-shapes.json");

const started = Date.now();
const result = runCodemod(root, paths.length > 0 ? { files: paths.map((each) => path.resolve(root, each)) } : {});
const sites: Site[] = result.files.flatMap((file) => file.sites);
const converted = sites.filter((site) => site.status === "converted");
const skipped = sites.filter((site) => site.status === "skipped");
const changed = result.files.filter((file) => file.output !== null);

if (write) for (const file of changed) writeFileSync(file.file, file.output!);
if (record) {
  type Recorded = Readonly<{ shapes: readonly Shape[]; cx: readonly CxShape[] }>;
  const previous: Recorded = existsSync(shapesFile) ? JSON.parse(readFileSync(shapesFile, "utf8")) : { shapes: [], cx: [] };
  const cx = new Map<string, CxShape>();
  for (const shape of [...previous.cx, ...result.cxShapes]) cx.set(JSON.stringify(shape), shape);
  const recorded: Recorded = {
    shapes: mergeShapes(previous.shapes, sites),
    cx: [...cx.values()].sort((a, b) => a.args.localeCompare(b.args)),
  };
  writeFileSync(shapesFile, JSON.stringify(recorded, null, 1) + "\n");
}

const report = option("--report");
if (report) writeFileSync(path.resolve(root, report), JSON.stringify({ converted, skipped, cxShapes: result.cxShapes, outOfScope: result.outOfScope }, null, 1) + "\n");

const byKind = (list: readonly Site[]) => {
  const counts: Record<string, number> = {};
  for (const site of list) counts[site.kind] = (counts[site.kind] ?? 0) + 1;
  return Object.entries(counts).map(([kind, count]) => `${kind} ${count}`).join(", ") || "none";
};
console.log(`clsx codemod (${write ? "write" : "dry run"}, ${((Date.now() - started) / 1000).toFixed(1)} s): ${converted.length} site(s) in ${changed.length} file(s) [${byKind(converted)}]`);
for (const site of converted) console.log(`  ${site.file}:${site.line}  ${site.before.replace(/\s+/g, " ")}  →  ${site.after!.replace(/\s+/g, " ")}`);
if (skipped.length > 0) {
  console.log(`skipped ${skipped.length} (left as they are):`);
  for (const site of skipped) console.log(`  ${site.file}:${site.line}  ${site.reason}\n      ${site.before.replace(/\s+/g, " ")}`);
}
console.log(`cx mapper call shapes: ${result.cxShapes.length}; template classNames outside the scope (launchpad, Mission Control; not converted): ${result.outOfScope.length}`);
if (check && converted.length > 0) process.exit(1);
