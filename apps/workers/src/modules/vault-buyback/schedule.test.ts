import assert from "node:assert/strict";
import test from "node:test";

import { DAY_MS, drawAmount, drawRunTime, nextPieceTime, randomBelow, retryDelay, secureRandom, secureUnit, shuffled, utcDay, type RandomSource } from "./schedule.ts";
import { BUYBACK_DEFAULTS, buybackSettingsFromEnvironment } from "./settings.ts";

const DAY = Date.UTC(2026, 9, 27);

/** An injected source that records each range asked and answers from a list. */
function scripted(answers: readonly number[]): RandomSource & { asked: number[] } {
  const asked: number[] = [];
  let next = 0;
  const source = ((max: number) => {
    asked.push(max);
    const answer = answers[next++ % answers.length]!;
    assert.ok(answer >= 0 && answer < max, `answer ${answer} within [0, ${max})`);
    return answer;
  }) as RandomSource & { asked: number[] };
  source.asked = asked;
  return source;
}

test("each vault's run time is drawn uniformly over what is left of its UTC day", () => {
  assert.deepEqual(utcDay(DAY + 5), { startMs: DAY, endMs: DAY + DAY_MS, date: "2026-10-27" });
  const first = scripted([0]);
  assert.equal(drawRunTime(DAY, first), DAY);
  assert.deepEqual(first.asked, [DAY_MS]);
  const last = scripted([DAY_MS - 1]);
  assert.equal(drawRunTime(DAY, last), DAY + DAY_MS - 1);
  // Planned at 18:00 UTC, it can land only in the remaining six hours.
  const evening = DAY + 18 * 3_600_000;
  const late = scripted([1_234]);
  assert.equal(drawRunTime(evening, late), evening + 1_234);
  assert.deepEqual(late.asked, [6 * 3_600_000]);
});

test("a piece's size is uniform over its bounds, exact for amounts beyond 2^47", () => {
  const low = 14_285_714_286n;
  const high = 30_000_000_000n;
  const bottom = scripted([0]);
  assert.equal(drawAmount(low, high, bottom), low);
  assert.deepEqual(bottom.asked, [Number(high - low + 1n)]);
  assert.equal(drawAmount(low, high, scripted([Number(high - low)])), high);
  assert.equal(drawAmount(5n, 5n, scripted([0])), 5n);
  assert.throws(() => drawAmount(6n, 5n, scripted([0])), RangeError);
  // A range wider than 2^47 draws 32-bit words: two words of 1 and 2 make 2^32 + 2.
  const wide = scripted([1, 2]);
  assert.equal(randomBelow(2n ** 60n, wide), 2n ** 32n + 2n);
  assert.deepEqual(wide.asked, [2 ** 32, 2 ** 32]);
  // An out-of-range draw (2^61 − 1 after masking) is rejected and drawn again.
  const rejected = scripted([0x1fffffff, 0xffffffff, 0, 9]);
  assert.equal(randomBelow(2n ** 60n + 1n, rejected), 9n);
  for (let draw = 0; draw < 64; draw += 1) {
    const amount = drawAmount(low, 10n ** 18n);
    assert.ok(amount >= low && amount <= 10n ** 18n);
  }
});

test("the next piece runs at a random time at least the gap later the same day, or tomorrow", () => {
  const gap = 15 * 60_000;
  const source = scripted([42]);
  assert.equal(nextPieceTime(DAY + 3_600_000, gap, source), DAY + 3_600_000 + gap + 42);
  assert.deepEqual(source.asked, [DAY_MS - 3_600_000 - gap]);
  assert.equal(nextPieceTime(DAY + DAY_MS - gap, gap, scripted([0])), null, "the day ends first");
});

test("the visiting order is a Fisher-Yates shuffle of the injected source", () => {
  const source = scripted([0, 0, 0]);
  assert.deepEqual(shuffled(["a", "b", "c", "d"], source), ["b", "c", "d", "a"]);
  assert.deepEqual(source.asked, [4, 3, 2]);
  assert.deepEqual(shuffled([], scripted([0])), []);
});

test("retries wait a random delay between half the ceiling and the ceiling", () => {
  assert.equal(retryDelay(60_000, scripted([0])), 30_000);
  assert.equal(retryDelay(60_000, scripted([30_000])), 60_000);
});

test("the default source is the CSPRNG, never Math.random", () => {
  const original = Math.random;
  Math.random = () => {
    throw new Error("Math.random must not be used");
  };
  try {
    const at = drawRunTime(DAY);
    assert.ok(at >= DAY && at < DAY + DAY_MS);
    assert.equal(shuffled([1, 2, 3]).length, 3);
    const unit = secureUnit();
    assert.ok(unit >= 0 && unit < 1);
    assert.ok(secureRandom(10) < 10);
    // 64 draws over a day are not all equal: the source is not constant.
    assert.ok(new Set(Array.from({ length: 64 }, () => drawRunTime(DAY))).size > 1);
  } finally {
    Math.random = original;
  }
});

const CAP = `0x${"ca".repeat(32)}`;

test("settings default to the owner's decisions and validate at start", () => {
  const settings = buybackSettingsFromEnvironment({ BLAST_BUYBACK_ADMIN_CAP_ID: CAP });
  assert.equal(settings.minUsdCents, 5_000n);
  assert.equal(settings.maxPoolShareBps, 100n);
  assert.equal(settings.slippageBps, 1_000n);
  assert.equal(BUYBACK_DEFAULTS.BLAST_BUYBACK_SLIPPAGE_BPS, "1000");
  assert.equal(settings.twapWindowMs, 30 * 60_000);
  assert.equal(settings.maxPiecesPerDay, 8);
  assert.equal(settings.minPieceGapMs, 15 * 60_000);
  const custom = buybackSettingsFromEnvironment({
    BLAST_BUYBACK_ADMIN_CAP_ID: CAP,
    BLAST_BUYBACK_MIN_USD: "75.5",
    BLAST_BUYBACK_SLIPPAGE_BPS: "800",
    BLAST_BUYBACK_TWAP_WINDOW_MS: "3600000",
  });
  assert.deepEqual([custom.minUsdCents, custom.slippageBps, custom.twapWindowMs], [7_550n, 800n, 3_600_000]);
  for (const [name, value] of [
    ["BLAST_BUYBACK_MIN_USD", "0"],
    ["BLAST_BUYBACK_MIN_USD", "50.001"],
    ["BLAST_BUYBACK_MAX_POOL_SHARE_BPS", "0"],
    ["BLAST_BUYBACK_MAX_POOL_SHARE_BPS", "10001"],
    ["BLAST_BUYBACK_SLIPPAGE_BPS", "0"],
    ["BLAST_BUYBACK_SLIPPAGE_BPS", "10000"],
    ["BLAST_BUYBACK_SLIPPAGE_BPS", "10%"],
    ["BLAST_BUYBACK_TWAP_WINDOW_MS", "90000"],
    ["BLAST_BUYBACK_ABORT_ALERT_AFTER", "0"],
    ["BLAST_BUYBACK_MAX_PIECES_PER_DAY", "0"],
    ["BLAST_BUYBACK_MIN_PIECE_GAP_MS", "1000"],
  ] as const) {
    assert.throws(() => buybackSettingsFromEnvironment({ BLAST_BUYBACK_ADMIN_CAP_ID: CAP, [name]: value }), new RegExp(name), `${name}=${value}`);
  }
  assert.throws(() => buybackSettingsFromEnvironment({}), /BLAST_BUYBACK_ADMIN_CAP_ID is required/);
  // Never beside another worker's key.
  for (const name of ["BLAST_WORKER_SIGNER_KEY", "VAULT_REWARDS_SIGNER_KEY", "PRESALE_REWARDS_SIGNER_KEY", "SOCIAL_SIGNER_KEY", "CREATOR_CLAIM_SIGNER_KEY"]) {
    assert.throws(() => buybackSettingsFromEnvironment({ BLAST_BUYBACK_ADMIN_CAP_ID: CAP, [name]: "suiprivkey1x" }), new RegExp(`${name} must not be set`));
  }
});
