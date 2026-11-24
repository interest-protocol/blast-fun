import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the web app rewrites and caches nothing under blast-infra's /v1", () => {
  const vercel = JSON.parse(
    readFileSync(new URL("../vercel.json", import.meta.url), "utf8"),
  ) as { rewrites?: { source: string }[]; headers?: { source: string }[] };
  for (const rule of [...(vercel.rewrites ?? []), ...(vercel.headers ?? [])]) {
    assert.doesNotMatch(rule.source, /^\/v1(\/|$)/, rule.source);
  }
});
