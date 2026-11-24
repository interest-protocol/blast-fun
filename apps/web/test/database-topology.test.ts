import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { NEON_REGION, VERCEL_REGION } from "@blast/core/modules/database/topology.ts";

const databaseImport = /\b(?:from\s+|import\s*(?:\(\s*)?|require\(\s*)["'](?:pg(?:\/[^"']*)?["']|[^"']*(?:modules\/database|read-routing\/chain-join|read-routing(?:\/index(?:\.ts)?)?["']))/;

test("the Neon region is colocated with the Vercel region", () => {
  const vercel = JSON.parse(
    readFileSync(new URL("../vercel.json", import.meta.url), "utf8"),
  ) as { regions: string[] };
  assert.deepEqual(vercel.regions, [VERCEL_REGION]);
  assert.equal(VERCEL_REGION, "iad1");
  assert.equal(NEON_REGION, "aws-us-east-1");
});

test("the client-bundle guard detects direct database driver imports", () => {
  for (const source of [
    'import { Pool } from "pg";',
    'import "pg";',
    'void import("pg");',
    'const driver = require("pg");',
  ]) {
    assert.match(source, databaseImport);
  }
  assert.doesNotMatch('import "pg-types";', databaseImport);
});

test("database endpoints stay out of client bundles", async () => {
  const { readdir } = await import("node:fs/promises");
  const root = new URL("../", import.meta.url);
  const example = readFileSync(new URL(".env.example", root), "utf8");
  assert.doesNotMatch(example, /^NEXT_PUBLIC_[A-Z_]*DATABASE/m);
  for (const name of ["DATABASE_URL", "DATABASE_REPLICA_URL", "DATABASE_MIGRATION_URL"]) {
    assert.match(example, new RegExp(`^${name}=$`, "m"), `${name} is documented without a value`);
  }

  const clientImports: string[] = [];
  for (const entry of await readdir(new URL("src/", root), { recursive: true })) {
    if (!/\.tsx?$/.test(entry)) continue;
    const source = readFileSync(new URL(`src/${entry}`, root), "utf8");
    if (!/^\s*["']use client["']/m.test(source)) continue;
    if (databaseImport.test(source)) {
      clientImports.push(entry);
    }
  }
  assert.deepEqual(clientImports, []);
});
