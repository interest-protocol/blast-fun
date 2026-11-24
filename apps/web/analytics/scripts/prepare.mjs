import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const contract = [
  "../../../workers/src/modules/analytics/contract.ts",
  "generated/aggregate-contract.ts",
];
const assets = [
  ["../../src/components/blast-ui/blast-ui.css", "public/tokens.css"],
  ["../../src/components/blast-ui/Controls.module.css", "public/controls.css"],
  [
    "../../src/components/blast-ui/PageHeader.module.css",
    "public/page-header.css",
  ],
  [
    "../../src/components/blast-ui/EmptyState.module.css",
    "public/empty-state.css",
  ],
  ["../../src/components/blast-ui/Skeleton.module.css", "public/skeleton.css"],
  [
    "../node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.mjs",
    "public/lightweight-charts.mjs",
  ],
];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const contractOnly = process.argv[2] === "--contract-only";
const [contractInput, contractOutput] = contract;
let source;
try {
  source = await readFile(new URL(contractInput, import.meta.url));
} catch (error) {
  if (error.code !== "ENOENT" || contractOnly) throw error;
  // Prepared standalone artifacts have no workspace. Verify all prepared inputs.
  const manifest = JSON.parse(
    await readFile(new URL("generated/inputs.json", root), "utf8"),
  );
  await Promise.all(
    [contract, ...assets].map(async ([, output]) => {
      if (manifest[output] !== hash(await readFile(new URL(output, root))))
        throw new Error("Prepared artifact changed");
    }),
  );
  process.exit(0);
}
const imports =
  source
    .toString("utf8")
    .match(
      /\bimport\s[^;]+;|\bexport\s[^;]*\bfrom\s[^;]+;|\bimport\s*\(|\brequire\s*\(/g,
    ) ?? [];
if (imports.length !== 1 || imports[0] !== 'import { z } from "zod";') {
  throw new Error(
    "Review new aggregate-contract dependencies before preparing the dashboard",
  );
}
await mkdir(new URL("generated/", root), { recursive: true });
// Checks in the same checkout can prepare and read the contract concurrently.
const temporaryContract = new URL(`${contractOutput}.${randomUUID()}.tmp`, root);
try {
  await writeFile(temporaryContract, source);
  await rename(temporaryContract, new URL(contractOutput, root));
} finally {
  await rm(temporaryContract, { force: true });
}
if (contractOnly) process.exit(0);

const prepared = await Promise.all(
  assets.map(async ([input, output]) => {
    const bytes = await readFile(new URL(input, import.meta.url));
    await writeFile(new URL(output, root), bytes);
    return [output, hash(bytes)];
  }),
);
await writeFile(
  new URL("generated/inputs.json", root),
  JSON.stringify(
    Object.fromEntries([[contractOutput, hash(source)], ...prepared]),
    null,
    2,
  ) + "\n",
);
