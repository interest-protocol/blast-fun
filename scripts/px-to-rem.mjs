#!/usr/bin/env node
// One-off codemod for the proportional Blast UI scale (2026-10-27): rewrites px lengths in
// Blast UI stylesheets as rem (16px = 1rem at the 1440px design anchor), so the whole
// interface follows the fluid root size in blast-ui.css.
//
// Kept as px: hairlines (<= 1.5px), anything inside @media/@container params, the
// coarse-pointer touch blocks, and 44/48px touch minimums elsewhere become max(px, rem).
//
//   node scripts/px-to-rem.mjs [--check] <file.css>...
import { readFile, writeFile } from "node:fs/promises";
import postcss from "postcss";

const check = process.argv.includes("--check");
const files = process.argv.slice(2).filter((arg) => arg !== "--check");
const TOUCH = new Set(["min-height", "min-width", "height", "width", "flex-basis"]);
const PX = /(-?\d*\.?\d+)px\b/g;

const rem = (px) => `${Number((px / 16).toFixed(4))}rem`;

function insideCoarse(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === "atrule" && /pointer:\s*coarse/.test(parent.params)) return true;
  }
  return false;
}

function convert(value, prop) {
  return value.replace(PX, (match, number) => {
    const px = Number(number);
    if (Math.abs(px) <= 1.5) return match;
    if (TOUCH.has(prop) && (px === 44 || px === 48)) return `max(${px}px, ${rem(px)})`;
    return rem(px);
  });
}

let changed = 0;
for (const file of files) {
  const source = await readFile(file, "utf8");
  const root = postcss.parse(source, { from: file });
  root.walkDecls((decl) => {
    if (insideCoarse(decl) || !decl.value.includes("px")) return;
    const next = convert(decl.value, decl.prop);
    if (next !== decl.value) decl.value = next;
  });
  const output = root.toString();
  if (output !== source) {
    changed++;
    if (!check) await writeFile(file, output);
  }
}
console.log(`${check ? "would change" : "changed"} ${changed} of ${files.length} files`);
