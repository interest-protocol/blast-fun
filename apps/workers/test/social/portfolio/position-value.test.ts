import assert from "node:assert/strict";
import test from "node:test";

import { CREATE_WAL_QUOTE_TYPE } from "@blast/core/modules/social/contracts/create.ts";
import { PORTFOLIO_COIN_TYPES } from "@blast/core/modules/social/portfolio/read.ts";
import { valueCommitments, type ValuedPosition } from "@blast/server/modules/social/portfolio/position-value.ts";
import { valuePortfolio } from "#workers/modules/social/portfolio/snapshot-value.ts";

/**
 * R3-40: the gold card's Committed and Claimable over every quote — a SUI
 * commitment valued at SUI's `chain_read_v1.prices` row, exactly — and the
 * same figures the daily snapshot (OA-25 Q16, `snapshot-value.ts`) takes for
 * the same positions and price, to the cent.
 */

const NOW = 1_790_000_000_000;
const SUI = { usd_price: "3.4187", as_of_ms: NOW - 30_000 };
const position = (status: ValuedPosition["status"], commitment: string, quote: "USDC" | "SUI"): ValuedPosition => ({
  commitment, status, quote_symbol: quote, quote_decimals: quote === "SUI" ? 9 : 6,
  claimable: { tokens: "0", quote_refund: commitment, sale_decimals: 9, price: null },
});

const POSITIONS: readonly ValuedPosition[] = [
  position("open", "100000000", "USDC"),
  position("closed", "750000000", "USDC"),
  position("claimable", "250000000", "USDC"),
  // 125.123456789 SUI open, 40.000000001 SUI claimable, and a delivered one in neither.
  position("open", "125123456789", "SUI"),
  position("claimable", "40000000001", "SUI"),
  position("delivered", "999000000000", "SUI"),
];

test("R3-40: a SUI-quoted commitment counts at SUI's price (it used to be dropped from the card), summed exactly and rounded once", () => {
  const { commitments, pricesAsOfMs } = valueCommitments(POSITIONS, { sui: SUI }, NOW);
  // 850 + 125.123456789 × 3.4187 = 850 + 427.759561849… → 1,277.76; 250 + 40.000000001 × 3.4187 = 386.748…
  assert.deepEqual(commitments, { committed_usd: "1277.76", claimable_usd: "386.75" });
  assert.equal(pricesAsOfMs, SUI.as_of_ms);
  // USDC alone needs no price and names none.
  assert.deepEqual(valueCommitments(POSITIONS.filter((one) => one.quote_symbol === "USDC"), {}, NOW), {
    commitments: { committed_usd: "850.00", claimable_usd: "250.00" },
    pricesAsOfMs: null,
  });
});

test("R3-40: the card and the daily snapshot agree to the cent on the same positions and price", () => {
  const card = valueCommitments(POSITIONS, { sui: SUI }, NOW).commitments;
  const snapshot = valuePortfolio({
    positions: POSITIONS.map((one) => ({
      commitment: one.commitment,
      status: one.status,
      quote_type: one.quote_symbol === "SUI" ? PORTFOLIO_COIN_TYPES.sui : PORTFOLIO_COIN_TYPES.usdc,
      quote_decimals: one.quote_decimals,
      claimable: one.claimable ? { ...one.claimable, sale_type: "sale-token" } : undefined,
    })),
    coins: [],
    cash: { usdc: "0", sui: "0" },
    prices: new Map([[PORTFOLIO_COIN_TYPES.sui, SUI]]),
    takenAtMs: NOW,
  });
  assert.equal(snapshot.kind, "valued");
  if (snapshot.kind !== "valued") return;
  assert.deepEqual(card, { committed_usd: snapshot.committed_usd, claimable_usd: snapshot.claimable_usd });
});

test("R3-40-AC-6: no total adds two units — without a fresh SUI price a part holding SUI is unknown, never smaller; zero needs no price", () => {
  const stale = { usd_price: "3.4187", as_of_ms: NOW - 121_000 };
  assert.deepEqual(valueCommitments(POSITIONS, { sui: stale }, NOW).commitments, { committed_usd: null, claimable_usd: null, known_committed_usd: "850.00", known_claimable_usd: "250.00" });
  assert.deepEqual(valueCommitments(POSITIONS, {}, NOW).commitments, { committed_usd: null, claimable_usd: null, known_committed_usd: "850.00", known_claimable_usd: "250.00" });
  // Only the part that holds SUI is unknown.
  const usdcClaimable = [position("open", "125000000000", "SUI"), position("claimable", "250000000", "USDC")];
  assert.deepEqual(valueCommitments(usdcClaimable, {}, NOW).commitments, { committed_usd: null, claimable_usd: "250.00", known_committed_usd: "0.00" });
  assert.deepEqual(valueCommitments([position("open", "0", "SUI")], {}, NOW).commitments, { committed_usd: "0.00", claimable_usd: "0.00" });
  // Nonzero amounts in quotes without a USD price remain unknown.
  assert.deepEqual(valueCommitments([{ commitment: "1", status: "open", quote_symbol: "TSUI", quote_decimals: 9 }], {}, NOW).commitments.committed_usd, null);
});

test("suiUSDT counts at par by coin type and other quote coins use a fresh indexed price", () => {
  const suiUsdt = {
    commitment: "7000000",
    status: "open",
    quote_symbol: "USDT",
    quote_type: "0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT",
    quote_decimals: 6,
  } satisfies ValuedPosition;
  const lookalike = { ...suiUsdt, quote_type: "0x1::usdt::USDT" };
  const wal = {
    ...suiUsdt,
    commitment: "2000000000",
    quote_symbol: "WAL",
    quote_type: CREATE_WAL_QUOTE_TYPE,
    quote_decimals: 9,
    quote_price: { usd_price: "0.50", as_of_ms: NOW - 1_000 },
  };
  assert.deepEqual(valueCommitments([suiUsdt, lookalike, wal], {}, NOW), {
    commitments: { committed_usd: null, known_committed_usd: "8.00", claimable_usd: "0.00" },
    pricesAsOfMs: NOW - 1_000,
  });
  const stale = { ...wal, quote_price: { usd_price: "0.50", as_of_ms: NOW - 121_000 } };
  assert.deepEqual(valueCommitments([suiUsdt, stale], {}, NOW), {
    commitments: { committed_usd: null, known_committed_usd: "7.00", claimable_usd: "0.00" },
    pricesAsOfMs: null,
  });
});

test("a different coin named USDC uses its own indexed quote price", () => {
  const lookalike = {
    ...position("open", "10000000", "USDC"),
    quote_type: "0x1::usdc::USDC",
    quote_price: { usd_price: "0.25", as_of_ms: NOW - 1_000 },
  };
  assert.equal(valueCommitments([lookalike], {}, NOW).commitments.committed_usd, "2.50");
});

test("commitment totals preserve exact cents beyond floating-point precision", () => {
  const large = position("open", "9007199254740992995000", "USDC");
  const dust = position("open", "4999", "USDC");
  assert.equal(valueCommitments([large], {}, NOW).commitments.committed_usd, "9007199254740993.00");
  assert.deepEqual(valueCommitments([dust], {}, NOW).commitments, {
    committed_usd: "0.00",
    claimable_usd: "0.00",
    has_priced_holdings: true,
    committed_usd_subcent: 0.004999,
  });
});

test("unpriced quote commitments and claim allocations remain unknown", () => {
  const testQuote = { commitment: "10000000000", quote_symbol: "TSUI", quote_decimals: 9 };
  assert.deepEqual(valueCommitments([
    { ...testQuote, status: "open" },
    { ...testQuote, status: "claimable", claimable: { tokens: "2000000000", quote_refund: "500000000", sale_decimals: 9, price: null } },
  ], {}, NOW), { commitments: { committed_usd: null, claimable_usd: null, known_committed_usd: "0.00", known_claimable_usd: "0.00" }, pricesAsOfMs: null });
  assert.equal(valueCommitments([{ ...testQuote, status: "claimable", claimable: { tokens: null, quote_refund: "0", sale_decimals: 9, price: null } }], {}, NOW).commitments.claimable_usd, null);
});


test("claimable value uses remaining tokens and refunds, never the original commitment", () => {
  const remaining: ValuedPosition = {
    ...position("claimable", "100000000", "USDC"),
    claimable: { tokens: "2500000000", quote_refund: "5000000", sale_decimals: 9, price: { usd_price: "2", as_of_ms: NOW - 1_000 } },
  };
  assert.deepEqual(valueCommitments([remaining], {}, NOW), {
    commitments: { committed_usd: "0.00", claimable_usd: "10.00" }, pricesAsOfMs: NOW - 1_000,
  });
  // A completed claim contributes nothing, even when an old allocation is present.
  assert.equal(valueCommitments([remaining, { ...remaining, status: "delivered" }], {}, NOW).commitments.claimable_usd, "10.00");
  for (const claimable of [undefined, { ...remaining.claimable!, tokens: null }, { ...remaining.claimable!, quote_refund: null },
    { ...remaining.claimable!, price: null }, { ...remaining.claimable!, price: { usd_price: "2", as_of_ms: NOW - 121_000 } }]) {
    assert.equal(valueCommitments([{ ...remaining, claimable }], {}, NOW).commitments.claimable_usd, null);
  }
  // A cancelled sale is refund-only; zero allocated tokens need no token price.
  assert.equal(valueCommitments([{ ...remaining, claimable: { ...remaining.claimable!, tokens: "0", price: null } }], {}, NOW).commitments.claimable_usd, "5.00");
  const snapshot = valuePortfolio({
    positions: [{ commitment: remaining.commitment, status: "claimable", quote_type: PORTFOLIO_COIN_TYPES.usdc, quote_decimals: 6,
      claimable: { tokens: "2500000000", quote_refund: "5000000", sale_decimals: 9, sale_type: "sale-token" } }],
    coins: [], cash: { sui: "0", usdc: "0" }, prices: new Map([["sale-token", remaining.claimable!.price!]]), takenAtMs: NOW,
  });
  assert.equal(snapshot.kind === "valued" ? snapshot.claimable_usd : snapshot.reason, "10.00");
});

test("mixed commitments and claim components retain priced subtotals in either input order", () => {
  const mixed: readonly ValuedPosition[] = [
    position("open", "100000000", "USDC"),
    { commitment: "1000000000", status: "open", quote_symbol: "TSUI", quote_decimals: 9 },
    { ...position("claimable", "10000000", "USDC"), claimable: { tokens: "2000000000", quote_refund: "5000000", sale_decimals: 9, price: null } },
    { commitment: "1000000000", status: "claimable", quote_symbol: "TSUI", quote_decimals: 9,
      claimable: { tokens: "3000000000", quote_refund: "1000000000", sale_decimals: 9, price: { usd_price: "1.25", as_of_ms: NOW - 1_000 } } },
    position("claimable", "10000000", "USDC"),
  ];
  for (const positions of [mixed, [...mixed].reverse()]) {
    assert.deepEqual(valueCommitments(positions, {}, NOW), {
      commitments: { committed_usd: null, claimable_usd: null, known_committed_usd: "100.00", known_claimable_usd: "18.75" },
      pricesAsOfMs: NOW - 1_000,
    });
  }
});
