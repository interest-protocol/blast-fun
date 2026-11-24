import assert from "node:assert/strict";
import test from "node:test";

import { itemWhyRefusal } from "@blast/server/modules/social/whys/store.ts";
import { WHY_MAX_CODE_POINTS, validateWhy, whyLength } from "@blast/core/modules/social/whys/validate.ts";

/** Social feed T-021: the shared why text rules (AC-077, AC-078) and the per-item limits (AC-080). */

test("validateWhy: NFC and trim, then empty, one line, length and links, in that order", () => {
  assert.deepEqual(validateWhy("  Cafe\u0301 is open  "), { ok: true, text: "Caf\u00e9 is open" });
  assert.deepEqual(validateWhy(""), { ok: false, code: "why_empty" });
  assert.deepEqual(validateWhy(" \t\u00a0\u3000\n"), { ok: false, code: "why_empty" });
  assert.deepEqual(validateWhy("one\ntwo"), { ok: false, code: "why_invalid" });
  assert.deepEqual(validateWhy("one\r\ntwo"), { ok: false, code: "why_invalid" });
  assert.deepEqual(validateWhy("one\u2029two"), { ok: false, code: "why_invalid" });
  assert.deepEqual(validateWhy("one\u0085two"), { ok: false, code: "why_invalid" });
  assert.deepEqual(validateWhy("tab\tinside"), { ok: false, code: "why_invalid" });
  // A trailing line break is trimmed, not refused.
  assert.deepEqual(validateWhy("conviction\n"), { ok: true, text: "conviction" });
  // A line break counts before the length: a long two-line text is why_invalid.
  assert.deepEqual(validateWhy(`${"a".repeat(300)}\nb`), { ok: false, code: "why_invalid" });
});

test("validateWhy: 280 Unicode code points is the most, counted as code points not UTF-16 units", () => {
  const rocket = "\u{1F680}";
  assert.equal(whyLength(rocket.repeat(3)), 3);
  assert.deepEqual(validateWhy(rocket.repeat(WHY_MAX_CODE_POINTS)), { ok: true, text: rocket.repeat(WHY_MAX_CODE_POINTS) });
  assert.deepEqual(validateWhy(rocket.repeat(WHY_MAX_CODE_POINTS + 1)), { ok: false, code: "why_too_long" });
  assert.deepEqual(validateWhy("a".repeat(281)), { ok: false, code: "why_too_long" });
  // Composed first: 280 letters each with a combining accent is 280 code points once composed.
  assert.deepEqual(validateWhy("e\u0301".repeat(280)).ok, true);
});

test("validateWhy: links are refused in any case; decimals and abbreviations are not links", () => {
  for (const text of [
    "see https://x.io",
    "http://localhost",
    "HTTPS://BLAST.FUN",
    "www.x",
    "WWW.example",
    "blast.fun",
    "BLAST.FUN",
    "read sui.io/blog",
    "my-site.co.uk is up",
    "a.museum",
  ]) {
    assert.deepEqual(validateWhy(text), { ok: false, code: "why_has_link" }, text);
  }
  for (const text of ["v2.0 soon", "up 4.2x since", "e.g. this one", "3.14159", "U.S. based team", "$0.0021 now", "a.b"]) {
    assert.equal(validateWhy(text).ok, true, text);
  }
});

test("itemWhyRefusal: an active why, then a removed one, then three records", () => {
  assert.equal(itemWhyRefusal([]), null);
  assert.equal(itemWhyRefusal(["deleted", "deleted"]), null);
  assert.equal(itemWhyRefusal(["active"]), "why_exists");
  assert.equal(itemWhyRefusal(["deleted", "active", "deleted"]), "why_exists");
  assert.equal(itemWhyRefusal(["removed"]), "why_removed");
  assert.equal(itemWhyRefusal(["deleted", "deleted", "removed"]), "why_removed");
  assert.equal(itemWhyRefusal(["deleted", "deleted", "deleted"]), "why_limit");
});
