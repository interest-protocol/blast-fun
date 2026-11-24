import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const postcss = createRequire(require.resolve("next/package.json"))("postcss");
const local = require("next/dist/compiled/postcss-modules-local-by-default");
const source = new URL("../apps/web/src/", import.meta.url);

test("all web CSS modules compile with Next's pure-selector validation", async () => {
  const files = await readdir(source, { recursive: true });
  for (const file of files.filter((name) => name.endsWith(".module.css"))) {
    const css = await readFile(new URL(file, source), "utf8");
    await postcss([local({ mode: "pure" })]).process(css, { from: fileURLToPath(new URL(file, source)) });
  }
});
