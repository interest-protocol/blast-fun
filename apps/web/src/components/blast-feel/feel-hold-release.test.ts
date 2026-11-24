import assert from "node:assert/strict";
import test from "node:test";

import type { FeelSignal } from "./feel-cues.ts";
import { FEEL_HOLD_FAILED, runHeldRelease, type HeldReleaseDeps } from "./feel-hold-release.ts";

/**
 * R3-13: a charged release, in order — the quote before anything flies, the
 * flight, then the commit, whose own answer (not the ball) is the success
 * signal. Every effect is recorded in one log, so the order is the test.
 */

function rig(overrides: Partial<HeldReleaseDeps> = {}) {
  const log: string[] = [];
  const deps: HeldReleaseDeps = {
    amountUsd: 500,
    play: (signal: FeelSignal) => log.push(`play:${signal.kind}`),
    motion: true,
    quote: async (amountUsd) => {
      log.push(`quote:${amountUsd}`);
      return null;
    },
    landing: () => {
      log.push("landing");
      return { x: 400, y: 120 };
    },
    shake: async () => {
      log.push("shake");
    },
    fly: async () => {
      log.push("fly");
    },
    flash: () => log.push("flash"),
    commit: async (amountUsd) => {
      log.push(`commit:${amountUsd}`);
    },
    refused: (message) => log.push(`refused:${message}`),
    ...overrides,
  };
  return { deps, log };
}

test("R3-13: a release quotes, fires, flies, flashes the bar, then commits — and the hold itself never plays land", async () => {
  const { deps, log } = rig();
  assert.equal(await runHeldRelease(deps), "committed");
  assert.deepEqual(log, ["quote:500", "play:fire", "landing", "fly", "flash", "commit:500"]);
  assert.equal(log.includes("play:land"), false, "the ball is not the success signal: the commit host plays land on the route's answer");
});

test("R3-13-AC-5: a quote refusal plays error, shakes the ball, says its own words, and commits nothing", async () => {
  const { deps, log } = rig({
    quote: async () => {
      log.push("quote");
      return "The minimum is $10";
    },
  });
  assert.equal(await runHeldRelease(deps), "refused");
  assert.deepEqual(log, ["quote", "play:error", "shake", "refused:The minimum is $10"]);
});

test("R3-13-AC-6: a commit that fails after the ball lands plays error and shows the error path; nothing else moves", async () => {
  const { deps, log } = rig({
    commit: async () => {
      log.push("commit");
      throw new Error("route said no");
    },
  });
  assert.equal(await runHeldRelease(deps), "failed");
  assert.deepEqual(log, ["quote:500", "play:fire", "landing", "fly", "flash", "commit", "play:error", `refused:${FEEL_HOLD_FAILED}`]);
});

test("R3-13-AC-7: under reduced motion no ball is made — no landing, no flight, no flash, no shake — and the commit goes on release with the same sounds", async () => {
  const sent = rig({ motion: false });
  assert.equal(await runHeldRelease(sent.deps), "committed");
  assert.deepEqual(sent.log, ["quote:500", "play:fire", "commit:500"]);
  const refused = rig({ motion: false, quote: async () => "Not enough to cover it" });
  await runHeldRelease(refused.deps);
  assert.deepEqual(refused.log, ["play:error", "refused:Not enough to cover it"]);
});

test("R3-13: with no bar on screen there is no flight, and the commit goes at once; a quote that throws refuses", async () => {
  const noBar = rig({
    landing: () => {
      noBar.log.push("landing");
      return null;
    },
  });
  await runHeldRelease(noBar.deps);
  assert.deepEqual(noBar.log, ["quote:500", "play:fire", "landing", "commit:500"]);
  const broken = rig({
    quote: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(await runHeldRelease(broken.deps), "refused");
  assert.deepEqual(broken.log, ["play:error", "shake", `refused:${FEEL_HOLD_FAILED}`]);
});
