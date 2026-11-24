import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "#web/test/css-design-px.ts";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { addClsxImport, cssModuleClasses, runCodemod } from "#web/scripts/codemods/clsx-core.ts";

/**
 * OA-28 M6: the clsx codemod (`scripts/codemods/clsx.ts`) is run again on the
 * final integration tree before the freeze, so it must convert what is new,
 * change nothing it already converted, and refuse what it cannot prove.
 */

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(tmpdir(), "clsx-codemod-"));
  const all: Record<string, string> = {
    "tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true, jsx: "preserve", target: "ES2022", module: "esnext", moduleResolution: "bundler", noEmit: true, skipLibCheck: true },
      include: ["**/*.ts", "**/*.tsx"],
    }),
    "css.d.ts": 'declare module "*.module.css" { const classes: { readonly [key: string]: string }; export default classes; }\n',
    "src/components/x/X.module.css": ".a { color: red }\n.on, .b:hover { color: blue }\n:global(.g) .c { }\n@media (min-width: 1px) { .m { } }\n",
    ...files,
  };
  for (const [name, text] of Object.entries(all)) {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return root;
}

const A = `"use client";

import { useState } from "react";

import styles from "./X.module.css";

export function A({ on, extra, tone }: { on: boolean; extra?: string; tone: "a" | "b" }) {
  void useState;
  return (
    <div className={\`\${styles.a}\${on ? \` \${styles.on}\` : ""}\`}>
      <span className={[styles.b, extra].filter(Boolean).join(" ")} />
      <i className={\`\${styles.missing} x\`} />
      <b className={\`btn \${styles[tone]}\`} />
      <u className={extra ? \`\${styles.a} \${extra}\` : styles.a} />
      <em className={\`\${styles[extra ?? "a"]} y\`} />
    </div>
  );
}
`;

function apply(root: string, files: readonly string[]) {
  const result = runCodemod(root, { files: files.map((each) => path.join(root, each)) });
  for (const file of result.files) if (file.output !== null) writeFileSync(file.file, file.output);
  return result;
}

test("OA-28 M6 codemod: converts what it can prove, skips the rest with the reason, adds the import once", () => {
  const root = project({ "src/components/x/A.tsx": A });
  try {
    const first = apply(root, ["src/components/x/A.tsx"]);
    const sites = first.files.flatMap((file) => file.sites);
    const converted = sites.filter((site) => site.status === "converted").map((site) => site.after);
    assert.deepEqual(converted, ["clsx(styles.a, on && styles.on)", "clsx(styles.b, extra)", 'clsx("btn", styles[tone])', "clsx(styles.a, extra)"]);
    const skipped = sites.filter((site) => site.status === "skipped").map((site) => site.reason);
    assert.equal(skipped.length, 2);
    assert.match(skipped[0]!, /X\.module\.css defines no \.missing$/);
    assert.match(skipped[1]!, /^CSS-module key not provably defined/);
    const text = readFileSync(path.join(root, "src/components/x/A.tsx"), "utf8");
    assert.match(text, /^"use client";\n\nimport clsx from "clsx";\nimport \{ useState \} from "react";\n/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OA-28 M6 codemod: a second run changes nothing; a run on a newer tree converts only the new sites", () => {
  const root = project({ "src/components/x/A.tsx": A });
  try {
    apply(root, ["src/components/x/A.tsx"]);
    const again = apply(root, ["src/components/x/A.tsx"]);
    assert.equal(again.files.every((file) => file.output === null), true);
    assert.equal(again.files.flatMap((file) => file.sites).filter((site) => site.status === "converted").length, 0);
    writeFileSync(path.join(root, "src/components/x/B.tsx"), `import styles from "./X.module.css";\n\nexport const B = ({ on }: { on: boolean }) => <p className={\`card \${styles.a} \${on ? styles.on : ""}\`} />;\n`);
    const newer = apply(root, ["src/components/x/A.tsx", "src/components/x/B.tsx"]);
    const converted = newer.files.flatMap((file) => file.sites).filter((site) => site.status === "converted");
    assert.deepEqual(converted.map((site) => [path.basename(site.file), site.after]), [["B.tsx", 'clsx("card", styles.a, on && styles.on)']]);
    assert.equal(newer.files.find((file) => file.file.endsWith("A.tsx"))!.output, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OA-28 M6 codemod: the stylesheet's exported classes, not its global or commented ones", () => {
  const root = project({ "src/components/x/X.module.css": ".a {} .on, .b:hover {} :global(.g) .c {} @media (min-width: 1px) { .m {} } @custom-rule .phantom {}" });
  try {
    const classes = cssModuleClasses(path.join(root, "src/components/x/X.module.css"));
    assert.deepEqual([...classes!].sort(), ["a", "b", "c", "m", "on"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OA-28 M6 codemod: the web scripts alias resolves outside src", () => {
  const root = project({
    "scripts/X.module.css": ".a {} .on {}",
    "src/components/x/A.tsx": 'import styles from "#web/scripts/X.module.css";\nexport const A = ({ on }: { on: boolean }) => <p className={`${styles.a}${on ? ` ${styles.on}` : ""}`} />;\n',
  });
  try {
    const result = apply(root, ["src/components/x/A.tsx"]);
    assert.deepEqual(result.files.flatMap((file) => file.sites).map((site) => site.after), ["clsx(styles.a, on && styles.on)"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OA-28 M6 codemod: the clsx import goes among the package imports, in alphabetical place", () => {
  assert.equal(
    addClsxImport('import Link from "next/link";\nimport { useState } from "react";\n\nimport { x } from "#web/lib/x";\n'),
    'import clsx from "clsx";\nimport Link from "next/link";\nimport { useState } from "react";\n\nimport { x } from "#web/lib/x";\n',
  );
  assert.equal(
    addClsxImport('"use client";\n\nimport { Dialog } from "@base-ui/react/dialog";\nimport { useRef } from "react";\n'),
    '"use client";\n\nimport { Dialog } from "@base-ui/react/dialog";\nimport clsx from "clsx";\nimport { useRef } from "react";\n',
  );
  assert.equal(addClsxImport('import styles from "./a.module.css";\n'), 'import clsx from "clsx";\n\nimport styles from "./a.module.css";\n');
  assert.equal(addClsxImport('import { a } from "aaa";\n\nimport { z } from "zzz";\n'), 'import { a } from "aaa";\nimport clsx from "clsx";\n\nimport { z } from "zzz";\n');
});

test("OA-28 M6 codemod: an array written one element per line stays one argument per line", () => {
  const root = project({
    "src/components/x/C.tsx": `import styles from "./X.module.css";\n\nexport function C({ on }: { on: boolean }) {\n  const classes = [\n    styles.a,\n    on ? styles.on : "",\n  ]\n    .filter(Boolean)\n    .join(" ");\n  return <p className={classes} />;\n}\n`,
  });
  try {
    apply(root, ["src/components/x/C.tsx"]);
    const text = readFileSync(path.join(root, "src/components/x/C.tsx"), "utf8");
    assert.match(text, /\n {2}const classes = clsx\(\n {4}styles\.a,\n {4}on && styles\.on,\n {2}\);\n/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
