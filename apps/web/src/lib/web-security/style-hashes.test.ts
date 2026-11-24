import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { createContentSecurityPolicy, securityHeaders, SONNER_STYLE_HASHES } from "./browser-policy.ts";

/**
 * OA-30: `style-src` lists sonner's runtime sheet by its hash. Run by
 * `npm test`.
 */

const NONCE = "a".repeat(32);
const SONNER_DIST = dirname(createRequire(import.meta.url).resolve("sonner"));

const hash = (text: string) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
const styleSources = (csp: string) => csp.split("; ").find((part) => part.startsWith("style-src "))?.split(" ").slice(1) ?? [];

/** The text sonner passes to its `__insertCSS` when its module loads, from the installed build. */
function insertedSheet(file: string): string {
  const entry = readFileSync(join(SONNER_DIST, file), "utf8");
  const call = /__insertCSS\("((?:[^"\\]|\\.)*)"\);/.exec(entry);
  assert.ok(call, `${file} still inserts its sheet when it loads`);
  return JSON.parse(`"${call[1]}"`) as string;
}

test("OA-30: style-src allows sonner's inserted sheet, and the empty <style> it appends first, by hash", () => {
  // Both builds a bundler may pick (`import` and `require`) insert the same text.
  const sheet = insertedSheet("index.mjs");
  assert.equal(insertedSheet("index.js"), sheet);
  assert.ok(sheet.startsWith("[data-sonner-toaster][dir=ltr]"));
  assert.deepEqual([...SONNER_STYLE_HASHES], [hash(sheet), hash("")]);

  for (const development of [false, true]) {
    const csp = createContentSecurityPolicy({ nonce: NONCE, development });
    assert.ok(SONNER_STYLE_HASHES.every((source) => styleSources(csp).includes(source)));
    assert.equal(securityHeaders({ nonce: NONCE, development })["Content-Security-Policy"], csp);
  }
});

function privyMetaMaskStyle(dist: string, extension: string): string {
  const marker = ".s1{stroke-linecap:round";
  const styles = new Set<string>();
  // Privy can emit this icon in several chunks, and their names change between releases.
  for (const chunk of readdirSync(dist).filter((file) => file.endsWith(extension))) {
    const source = readFileSync(join(dist, chunk), "utf8");
    if (!source.includes(marker)) continue;
    const sheets = [...source.matchAll(/"style",\{children:("(?:[^"\\]|\\.)*")\}/g)]
      .map((match) => JSON.parse(match[1]) as string)
      .filter((sheet) => sheet.includes(marker));
    assert.ok(sheets.length, `Locate the MetaMask stylesheet literal in ${chunk}`);
    for (const sheet of sheets) styles.add(sheet);
  }
  assert.equal(styles.size, 1, `Expected one distinct MetaMask stylesheet in Privy's ${extension} chunks`);
  return [...styles][0];
}

test("style-src allows Privy's bundled MetaMask icon stylesheet by its exact hash", () => {
  const esm = dirname(fileURLToPath(import.meta.resolve("@privy-io/react-auth")));
  const cjs = dirname(createRequire(import.meta.url).resolve("@privy-io/react-auth"));
  const css = privyMetaMaskStyle(esm, ".mjs");
  assert.equal(privyMetaMaskStyle(cjs, ".js"), css);
  for (const development of [false, true]) {
    const csp = createContentSecurityPolicy({ nonce: NONCE, development });
    assert.deepEqual(styleSources(csp), ["'self'", `'nonce-${NONCE}'`, ...SONNER_STYLE_HASHES, hash(css)]);
  }
});

test("Next/image's installed SSR style remains covered by the attribute hash", () => {
  const Image = createRequire(import.meta.url)("next/image").default;
  const html = renderToStaticMarkup(createElement(Image, {
    src: "/blast-helmet.svg", alt: "", width: 462, height: 315, unoptimized: true,
  }));
  const style = /<img[^>]*style="([^"]*)"/.exec(html)?.[1];
  assert.equal(style, "color:transparent");
  const directive = createContentSecurityPolicy({ nonce: NONCE }).split("; ")
    .find((part) => part.startsWith("style-src-attr "));
  assert.equal(directive, `style-src-attr 'unsafe-hashes' ${hash(style)}`);
});
