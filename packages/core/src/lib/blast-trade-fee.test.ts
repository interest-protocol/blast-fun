import assert from "node:assert/strict";
import test from "node:test";

import { blastTradeFeeAtoms, parseBlastTradeFee } from "./blast-trade-fee.ts";

/** A made-up receiver: never a real treasury. */
const RECEIVER = `0x${"fe".repeat(32)}`;

test("owner 2026-10-08: BLAST_TRADE_FEE_BPS=50 with a receiver is 0.5%, 5,000 parts per million", () => {
  assert.deepEqual(parseBlastTradeFee({ BLAST_TRADE_FEE_BPS: "50", BLAST_TRADE_FEE_RECEIVER: RECEIVER }), { bps: 50, ppm: 5_000, receiver: RECEIVER });
  assert.deepEqual(parseBlastTradeFee({ BLAST_TRADE_FEE_BPS: " 1000 ", BLAST_TRADE_FEE_RECEIVER: ` ${RECEIVER} ` }), { bps: 1_000, ppm: 100_000, receiver: RECEIVER });
});

test("no fee: both unset or blank, or 0 bps", () => {
  assert.equal(parseBlastTradeFee({}), null);
  assert.equal(parseBlastTradeFee({ BLAST_TRADE_FEE_BPS: "", BLAST_TRADE_FEE_RECEIVER: "  " }), null);
  assert.equal(parseBlastTradeFee({ BLAST_TRADE_FEE_BPS: "0" }), null);
  assert.equal(parseBlastTradeFee({ BLAST_TRADE_FEE_BPS: "0", BLAST_TRADE_FEE_RECEIVER: RECEIVER }), null);
});

test("anything else that is not a valid pair throws: a deployment that meant to charge never trades without it", () => {
  for (const environment of [
    { BLAST_TRADE_FEE_BPS: "50" },
    { BLAST_TRADE_FEE_RECEIVER: RECEIVER },
    { BLAST_TRADE_FEE_BPS: "1001", BLAST_TRADE_FEE_RECEIVER: RECEIVER },
    { BLAST_TRADE_FEE_BPS: "-1", BLAST_TRADE_FEE_RECEIVER: RECEIVER },
    { BLAST_TRADE_FEE_BPS: "0.5", BLAST_TRADE_FEE_RECEIVER: RECEIVER },
    { BLAST_TRADE_FEE_BPS: "050", BLAST_TRADE_FEE_RECEIVER: RECEIVER },
    { BLAST_TRADE_FEE_BPS: "5e1", BLAST_TRADE_FEE_RECEIVER: RECEIVER },
    { BLAST_TRADE_FEE_BPS: "50", BLAST_TRADE_FEE_RECEIVER: `0x${"0".repeat(64)}` },
    { BLAST_TRADE_FEE_BPS: "50", BLAST_TRADE_FEE_RECEIVER: "0x0" },
    { BLAST_TRADE_FEE_BPS: "50", BLAST_TRADE_FEE_RECEIVER: "0xfe" },
    { BLAST_TRADE_FEE_BPS: "50", BLAST_TRADE_FEE_RECEIVER: RECEIVER.toUpperCase().replace("0X", "0x") },
    { BLAST_TRADE_FEE_BPS: "50", BLAST_TRADE_FEE_RECEIVER: RECEIVER.slice(2) },
    { BLAST_TRADE_FEE_BPS: "0", BLAST_TRADE_FEE_RECEIVER: "treasury" },
  ]) {
    assert.throws(() => parseBlastTradeFee(environment), /BLAST_TRADE_FEE_/, JSON.stringify(environment));
  }
});

test("the fee's atoms are the aggregator's: ⌊gross × ppm ÷ 10⁶⌋, exact past 2^53", () => {
  const fee = parseBlastTradeFee({ BLAST_TRADE_FEE_BPS: "50", BLAST_TRADE_FEE_RECEIVER: RECEIVER });
  assert.equal(blastTradeFeeAtoms(332_001_975_262_684_891n, fee), 1_660_009_876_313_424n);
  assert.equal(blastTradeFeeAtoms(199n, fee), 0n, "below 200 atoms the fee rounds to nothing");
  assert.equal(blastTradeFeeAtoms(200n, fee), 1n);
  assert.equal(blastTradeFeeAtoms(10n ** 18n, null), 0n);
});
