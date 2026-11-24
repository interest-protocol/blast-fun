import assert from "node:assert/strict";
import test from "node:test";

import { isSocialEnabled, isTradingVisible } from "./social-flag.ts";

test("T-006-AC-2: the social feed is off unless the server sets BLAST_SOCIAL_ENABLED to exactly true", () => {
  assert.equal(isSocialEnabled({}), false);
  for (const value of ["", "false", "0", "1", "TRUE", "True", "true ", " true", "yes"]) {
    assert.equal(isSocialEnabled({ BLAST_SOCIAL_ENABLED: value }), false, JSON.stringify(value));
  }
  assert.equal(isSocialEnabled({ BLAST_SOCIAL_ENABLED: "true" }), true);
  // Other flags never turn it on.
  assert.equal(
    isSocialEnabled({ BLAST_EXPERIENCE_ENABLED: "true", BLAST_PRESALE_ENABLED: "true", BLAST_LAUNCHPAD_ENABLED: "true" }),
    false,
  );
});

test("the social flag reads process.env by default", () => {
  const previous = process.env.BLAST_SOCIAL_ENABLED;
  try {
    delete process.env.BLAST_SOCIAL_ENABLED;
    assert.equal(isSocialEnabled(), false);
    process.env.BLAST_SOCIAL_ENABLED = "true";
    assert.equal(isSocialEnabled(), true);
  } finally {
    if (previous === undefined) delete process.env.BLAST_SOCIAL_ENABLED;
    else process.env.BLAST_SOCIAL_ENABLED = previous;
  }
});

test("UI-02 (OA-7): trading surfaces stay hidden unless the server sets BLAST_TRADING_ENABLED to exactly true", () => {
  assert.equal(isTradingVisible({}), false);
  for (const value of ["", "false", "1", "TRUE", "true "]) {
    assert.equal(isTradingVisible({ BLAST_TRADING_ENABLED: value }), false, JSON.stringify(value));
  }
  assert.equal(isTradingVisible({ BLAST_TRADING_ENABLED: "true" }), true);
  assert.equal(isTradingVisible({ BLAST_SOCIAL_ENABLED: "true", BLAST_PRESALE_ENABLED: "true" }), false);
});
