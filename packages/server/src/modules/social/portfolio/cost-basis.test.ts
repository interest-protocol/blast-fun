import assert from "node:assert/strict";
import test from "node:test";

import { NO_COST_BASIS } from "@blast/core/modules/social/contracts/portfolio.ts";
import {
  coinBasisFigures,
  costBasisBook,
  costBasisFiguresOf,
  presaleCallMultiple,
  UNKNOWN_BASIS,
  type CoinHolding,
  type CostBasisLedger,
  type CostBasisRow,
} from "@blast/server/modules/social/portfolio/cost-basis.ts";
import type { SaleCoinHolding } from "@blast/server/modules/social/portfolio/holdings.ts";

const NOW = 1_800_000_000_000;
const SALE = `0x${"5a1e".padStart(64, "0")}`;
const OTHER = `0x${"5a1f".padStart(64, "0")}`;
const A = `0x${"a".padStart(64, "0")}`;
const B = `0x${"b".padStart(64, "0")}`;

type Extra = Partial<Omit<CostBasisRow, "kind">>;
const row = (kind: CostBasisRow["kind"], extra: Extra = {}): CostBasisRow => ({
  kind, presale_id: SALE, actor: A, quote_amount: "0", coin_amount: null, quote_refund: null, usd_value: null, ...extra,
});
const commit = (quote: string, usd: string | null, extra: Extra = {}) => row("presale_commit", { quote_amount: quote, usd_value: usd, ...extra });
const claim = (tokens: string, refund: string, extra: Extra = {}) => row("presale_claim", { coin_amount: tokens, quote_refund: refund, ...extra });
const buy = (tokens: string, usd: string | null, extra: Extra = {}) => row("trade_buy", { coin_amount: tokens, quote_amount: "1", usd_value: usd, ...extra });
const sell = (tokens: string, usd: string | null, extra: Extra = {}) => row("trade_sell", { coin_amount: tokens, quote_amount: "1", usd_value: usd, ...extra });
const ledger = (...rows: CostBasisRow[]): CostBasisLedger => ({ rows, truncated: false });
const holding = (balance: string, price: string | null = "0.0042", decimals = 9, asOfMs = NOW - 5_000): CoinHolding => ({
  balance, decimals, price: price === null ? null : { usd_price: price, as_of_ms: asOfMs },
});
const figures = (rows: CostBasisLedger, held: CoinHolding | null, presaleId = SALE) => coinBasisFigures(costBasisBook(rows), presaleId, held, NOW);

test("R3-32-AC-1: a claim alone costs the commitments' USD that bought it; the multiple is value ÷ basis", () => {
  // Committed 1,000 USDC worth $1,000 at event time; 200 refunded, so $800 bought 800,000 tokens ($0.001 each).
  const only = ledger(commit("600000000", "600"), commit("400000000", "400"), claim("800000000000000", "200000000"));
  // 800,000 at $0.0042 = $3,360: P&L $2,560, 4.2×.
  assert.deepEqual(figures(only, holding("800000000000000")), {
    basis_usd: "800.00", basis_complete: true, pnl_usd: "2560.00", pnl_multiple: "4.2000",
  });
  // No refund: the whole commitment is the basis.
  assert.deepEqual(figures(ledger(commit("250000000", "249.975"), claim("90000000000000", "0")), holding("90000000000000", "0.0021")).basis_usd, "249.98");
});

test("R3-32-AC-2: two buys average; a partial sell takes its share and leaves the per-token average unchanged", () => {
  // Claim 1,000 tokens for $100, buy 1,000 for $300 and 500 for $250: 2,500 tokens for $650, $0.26 each.
  const bought = [commit("100000000", "100"), claim("1000000000000", "0"), buy("1000000000000", "300"), buy("500000000000", "250")];
  assert.deepEqual(figures(ledger(...bought), holding("2500000000000", "0.5")), {
    // 2,500 at $0.50 = $1,250: P&L $600, 1.923076…×.
    basis_usd: "650.00", basis_complete: true, pnl_usd: "600.00", pnl_multiple: "1.9231",
  });
  // Sell 1,000 for $500: a cost of 1,000 × $0.26 = $260 leaves $390 for 1,500 tokens, still $0.26 each.
  const sold = ledger(...bought, sell("1000000000000", "500"));
  assert.deepEqual(figures(sold, holding("1500000000000", "0.5")), {
    basis_usd: "390.00", basis_complete: true, pnl_usd: "360.00", pnl_multiple: "1.9231",
  });
  const state = costBasisBook(sold).coins.get(SALE);
  assert.equal(state?.tracked, 1_500_000_000_000n);
  // $390 in 10⁻¹⁸ dollars, and the realised part kept apart: $500 − $260.
  assert.equal(state?.basis, 390n * 10n ** 18n);
  assert.equal(state?.realised, 240n * 10n ** 18n);
});

test("R3-32-AC-3: a full sell leaves a zero basis and no P&L or multiple, never infinity or zero", () => {
  const all = ledger(commit("100000000", "100"), claim("1000000000000", "0"), buy("1000000000000", "300"), sell("2000000000000", "900"));
  for (const held of [holding("0"), null]) {
    assert.deepEqual(figures(all, held), { basis_usd: "0.00", basis_complete: true, pnl_usd: null, pnl_multiple: null });
  }
  // $900 for what cost $400.
  assert.equal(costBasisBook(all).coins.get(SALE)?.realised, 500n * 10n ** 18n);
});

test("R3-32-AC-4: a transferred-in balance is an unknown component: basis_complete false and no multiple", () => {
  // Nothing in the ledger at all: the whole balance arrived by transfer.
  assert.deepEqual(figures(ledger(), holding("5000000000")), UNKNOWN_BASIS);
  // Bought 1,000 for $300, holds 1,500: the known part is shown, flagged, with no P&L.
  assert.deepEqual(figures(ledger(buy("1000000000000", "300")), holding("1500000000000")), {
    basis_usd: "300.00", basis_complete: false, pnl_usd: null, pnl_multiple: null,
  });
  // An unpriced buy or commitment is unknown too, until everything is sold.
  const unpriced = [buy("1000000000000", "300"), buy("1000000000000", null)];
  assert.equal(figures(ledger(...unpriced), holding("2000000000000")).basis_complete, false);
  assert.equal(figures(ledger(...unpriced, sell("500000000000", "100")), holding("1500000000000")).basis_complete, false);
  assert.deepEqual(figures(ledger(...unpriced, sell("2000000000000", "100")), holding("0")), {
    basis_usd: "0.00", basis_complete: true, pnl_usd: null, pnl_multiple: null,
  });
  assert.deepEqual(figures(ledger(commit("100000000", null), claim("1000000000000", "0")), holding("1000000000000")), UNKNOWN_BASIS);
  // A claim the ledger has no commitment for (its wallet committed elsewhere).
  assert.deepEqual(figures(ledger(claim("1000000000000", "0")), holding("1000000000000")), UNKNOWN_BASIS);
  // Selling tokens the ledger never saw arrive: the realised part is unknown.
  assert.equal(costBasisBook(ledger(sell("10", "1"))).coins.get(SALE)?.realised, null);
});

test("R3-32-AC-6: atom amounts and prices chosen to break a float give the exact answer", () => {
  // $0.1 + $0.2 for 3 tokens at $0.100005: exactly 1.00005×, half up to 1.0001. In floats 0.1 + 0.2 ≠ 0.3.
  const float = (3 * 0.100005) / (0.1 + 0.2);
  assert.equal(float.toFixed(4), "1.0000");
  assert.deepEqual(figures(ledger(buy("1000000", "0.1"), buy("2000000", "0.2")), holding("3000000", "0.100005", 6)), {
    basis_usd: "0.30", basis_complete: true, pnl_usd: "0.00", pnl_multiple: "1.0001",
  });
  // u64::MAX atoms, beyond any float's integers, at a sub-cent price: 18,446.744073709551615 → $18,446.74.
  const max = "18446744073709551615";
  assert.notEqual(String(Number(max)), max);
  assert.deepEqual(figures(ledger(buy(max, "9223.372036854775807")), holding(max, "0.000001")), {
    // Exactly 2.000000000000000000108…×.
    basis_usd: "9223.37", basis_complete: true, pnl_usd: "9223.37", pnl_multiple: "2.0000",
  });
  // A third of a basis, 18 places, and back: the sell's share is rounded once, half up at 10⁻¹⁸.
  const thirds = costBasisBook(ledger(buy("3", "1"), sell("1", "1"))).coins.get(SALE);
  assert.equal(thirds?.basis, 666_666_666_666_666_667n);
  assert.equal(thirds?.realised, 1n * 10n ** 18n - 333_333_333_333_333_333n);
});

test("selling a large holding leaves its last atom and dollar of basis intact", () => {
  const rows = ledger(
    buy("9007199254740993", "9007199254740993"),
    sell("9007199254740992", "9007199254740992"),
  );
  assert.deepEqual(figures(rows, holding("1", "1", 0)), {
    basis_usd: "1.00",
    basis_complete: true,
    pnl_usd: "0.00",
    pnl_multiple: "1.0000",
  });
  assert.equal(costBasisBook(rows).coins.get(SALE)?.tracked, 1n);
});

test("displayed P&L subtracts displayed cents while the multiple keeps sub-cent precision", () => {
  for (const [price, expected] of [
    ["0.004999999999999999", "0.00"],
    ["0.005", "0.01"],
    ["0.005000000000000001", "0.01"],
  ] as const) {
    assert.deepEqual(
      figures(ledger(buy("1", "0.0001")), holding("1", price, 0)),
      {
        basis_usd: "0.00",
        basis_complete: true,
        pnl_usd: expected,
        pnl_multiple: "50.0000",
      },
    );
  }
});

test("R3-32: a zero basis, a coin with no price and tokens that left without a trade", () => {
  // A buy priced at $0: a known zero basis, so no P&L or multiple.
  assert.deepEqual(figures(ledger(buy("1000000000000", "0")), holding("1000000000000")), {
    basis_usd: "0.00", basis_complete: true, pnl_usd: null, pnl_multiple: null,
  });
  const bought = ledger(buy("1000000000000", "300"));
  // No price, or one older than 120 s: the basis, and no P&L.
  for (const held of [holding("1000000000000", null), holding("1000000000000", "0.5", 9, NOW - 121_000)]) {
    assert.deepEqual(figures(bought, held), { basis_usd: "300.00", basis_complete: true, pnl_usd: null, pnl_multiple: null });
  }
  // A loss is signed.
  assert.deepEqual(figures(bought, holding("1000000000000", "0.21")), {
    basis_usd: "300.00", basis_complete: true, pnl_usd: "-90.00", pnl_multiple: "0.7000",
  });
  // Holds 400 of the 1,000 (600 transferred out): they leave at the average, $0.30 each.
  assert.deepEqual(figures(bought, holding("400000000000", "0.5")), {
    basis_usd: "120.00", basis_complete: true, pnl_usd: "80.00", pnl_multiple: "1.6667",
  });
  // A cancelled sale's claim refunds everything and acquires nothing; never held, no basis.
  assert.deepEqual(figures(ledger(commit("100000000", "100"), claim("0", "100000000")), null), NO_COST_BASIS);
  assert.deepEqual(figures(ledger(commit("100000000", "100")), holding("0")), NO_COST_BASIS);
});

test("R3-32: the account's wallets are one holding, coins are kept apart, and a ledger cut short knows nothing", () => {
  // Wallet A claims and moves the tokens to wallet B, which sells half: the move is not a disposal.
  const moved = ledger(
    commit("100000000", "100"), claim("1000000000000", "0"), sell("500000000000", "80", { actor: B }),
    buy("10", "5", { presale_id: OTHER }),
  );
  assert.deepEqual(figures(moved, holding("500000000000", "0.5")), {
    basis_usd: "50.00", basis_complete: true, pnl_usd: "200.00", pnl_multiple: "5.0000",
  });
  assert.equal(figures(moved, holding("10", "1", 0), OTHER).basis_usd, "5.00");
  // A claim prices each wallet's own commitments: A's $100 with $50 back, B's $90 unpriced.
  const two = costBasisBook(ledger(
    commit("100000000", "100"), commit("90000000", null, { actor: B }),
    claim("500000000000", "50000000"), claim("400000000000", "10000000", { actor: B }),
  ));
  assert.deepEqual(two.presales.get(SALE), { presale_id: SALE, tokens: 900_000_000_000n, basis: 50n * 10n ** 18n, unknown: true });
  assert.deepEqual(coinBasisFigures({ ...costBasisBook(moved), truncated: true }, SALE, holding("500000000000"), NOW), UNKNOWN_BASIS);
});

test("R3-32-AC-5 (OA-9): a call's multiple is this basis restricted to the presale acquisition", () => {
  const only = ledger(commit("1000000000", "1000"), claim("800000000000000", "200000000"));
  const price = { usd_price: "0.0042", as_of_ms: NOW - 5_000 };
  const call = presaleCallMultiple(costBasisBook(only).presales.get(SALE), 9, price, NOW);
  assert.equal(call, "4.2000");
  assert.equal(call, figures(only, holding("800000000000000")).pnl_multiple);
  // After a buy the coin's own multiple moves, and the call's stays the presale's.
  const more = ledger(...only.rows, buy("800000000000000", "6720"));
  assert.equal(presaleCallMultiple(costBasisBook(more).presales.get(SALE), 9, price, NOW), "4.2000");
  // 1,600,000 at $0.0042 = $6,720 over $800 + $6,720.
  assert.equal(figures(more, holding("1600000000000000")).pnl_multiple, "0.8936");
  // No claim, an unknown cost or no fresh price: no multiple.
  assert.equal(presaleCallMultiple(costBasisBook(ledger(commit("1000000000", "1000"))).presales.get(SALE), 9, price, NOW), null);
  assert.equal(presaleCallMultiple(costBasisBook(ledger(claim("1", "0"))).presales.get(SALE), 9, price, NOW), null);
  assert.equal(presaleCallMultiple(costBasisBook(only).presales.get(SALE), 9, { ...price, as_of_ms: NOW - 121_000 }, NOW), null);
});

test("R3-32: costBasisFiguresOf answers every presale from the ledger and the holdings, unknown when either is missing", () => {
  const sale = (presaleId: string, balance: string): SaleCoinHolding => ({
    presale_id: presaleId, coin_type: `${presaleId}::coin::S`, symbol: "S", decimals: 9, balance, price: { usd_price: "0.5", as_of_ms: NOW },
  });
  const book = ledger(buy("1000000000000", "300"));
  const of = costBasisFiguresOf(book, [sale(SALE, "1000000000000")], NOW);
  assert.deepEqual(of(SALE), { basis_usd: "300.00", basis_complete: true, pnl_usd: "200.00", pnl_multiple: "1.6667" });
  assert.equal(of(SALE), of(SALE));
  assert.deepEqual(of(OTHER), NO_COST_BASIS);
  assert.deepEqual(costBasisFiguresOf(null, [sale(SALE, "1")], NOW)(SALE), UNKNOWN_BASIS);
  assert.deepEqual(costBasisFiguresOf(book, null, NOW)(SALE), UNKNOWN_BASIS);
});
