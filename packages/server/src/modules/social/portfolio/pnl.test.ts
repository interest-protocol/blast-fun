import assert from "node:assert/strict";
import test from "node:test";

import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import type { WalletHoldings } from "@blast/server/modules/social/portfolio/wallet-holdings.ts";
import type { CostBasisRow } from "@blast/server/modules/social/portfolio/cost-basis.ts";
import { lifetimePnl } from "@blast/server/modules/social/portfolio/pnl.ts";
import { readPnlLedger } from "@blast/server/modules/social/portfolio/pnl-ledger.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";

const NOW = 1_800_000_000_000;
const SALE = `0x${"a".repeat(64)}`;
const OTHER = `0x${"b".repeat(64)}`;
const COIN = `${SALE}::coin::COIN`;
const metadata = [{ presale_id: SALE, coin_type: COIN, symbol: "COIN", icon_url: "https://i.blast.test/coin.png", decimals: 0 }];
const validator = createSocialValidator();
const row = (kind: CostBasisRow["kind"], amount: string, usd: string | null, extra: Partial<CostBasisRow> = {}): CostBasisRow => ({
  kind, presale_id: SALE, actor: "wallet-a", coin_amount: amount, quote_amount: "1", quote_refund: null, usd_value: usd, ...extra,
});
function wallet(balance: string, price: string | null = "2", age = 0): WalletHoldings {
  return {
    sync: { status: "ready", checkpoint: "10", as_of_ms: NOW },
    holdings: balance === "0" ? [] : [{ coin_type: COIN, symbol: "COIN", name: null, icon_url: null, decimals: 0, presale_id: SALE, balance, price: price === null ? null : { usd_price: price, as_of_ms: NOW - age }, priceUnavailable: false }],
  };
}
const pnl = (rows: readonly CostBasisRow[], balance: string, price: string | null = "2") => lifetimePnl({ rows, truncated: false }, wallet(balance, price), metadata, NOW);

test("opening holdings retain unknown cost through mixed buys, partial sales and linked-wallet transfers", () => {
  const opening = row("pnl_opening_balance", "100", null);
  const bought = row("trade_buy", "100", "100", { actor: "wallet-b" });
  const held = pnl([opening, bought], "200");
  assert.equal(held.period, "since_launch");
  assert.equal(held.assets[0].tracked_balance, "200");
  assert.equal(held.assets[0].basis_usd, null);
  assert.deepEqual(held.totals, { realized_usd: "0.00", unrealized_usd: null, total_usd: null });
  const partial = pnl([opening, bought, row("trade_sell", "50", "200", { actor: "wallet-b" })], "150");
  assert.deepEqual(partial.totals, { realized_usd: null, unrealized_usd: null, total_usd: null });
  const closed = pnl([opening, bought, row("trade_sell", "200", "400")], "0");
  assert.deepEqual(closed.totals, { realized_usd: null, unrealized_usd: "0.00", total_usd: null });
  assert.equal(pnl([opening, bought], "200", null).totals.total_usd, null);
  assert.deepEqual(validator.validate("pnl-response", partial).errors, []);
});

test("prelaunch presale commitments keep later claims unknown across contributions and refunds", () => {
  const opening = row("pnl_opening_commitment", "0", null, { quote_amount: "0" });
  for (const refund of ["0", "20", "100"]) {
    const claim = row("presale_claim", "100", null, { quote_refund: refund });
    for (const additions of [[], [row("presale_commit", "0", "50", { quote_amount: "50" })]]) {
      const answer = pnl([opening, ...additions, claim, row("trade_sell", "50", "100")], "50");
      assert.equal(answer.assets[0].basis_usd, null);
      assert.deepEqual(answer.totals, { realized_usd: null, unrealized_usd: null, total_usd: null });
    }
  }
  const otherWallet = pnl([opening,
    row("presale_commit", "0", "50", { actor: "wallet-b", quote_amount: "50" }),
    row("presale_claim", "100", null, { actor: "wallet-b", quote_refund: "0" }),
  ], "100");
  assert.equal(otherWallet.assets[0].basis_usd, "50.00", "an unclaimed opening commitment cannot contaminate another wallet's priced claim");
});

test("PnL remains unavailable before launch, including accounts without linked wallets", async () => {
  const inactive = { async read() { return { rows: [] }; } } as unknown as ReadableDatabase;
  await assert.rejects(readPnlLedger(inactive, []), { code: "service_unavailable" });
  await assert.rejects(readPnlLedger(inactive, ["wallet-a"]), { code: "service_unavailable" });
  const active = { async read() { return { rows: [{ first_checkpoint: "100" }] }; } } as unknown as ReadableDatabase;
  assert.deepEqual(await readPnlLedger(active, []), { rows: [], truncated: false });
});

test("PnL since launch keeps closed assets and averages partial sells, profits and losses", () => {
  const buys = [row("trade_buy", "100", "100"), row("trade_buy", "100", "300")];
  const partial = [...buys, row("trade_sell", "50", "150")];
  assert.deepEqual(pnl(partial, "150", "3").totals, { realized_usd: "50.00", unrealized_usd: "150.00", total_usd: "200.00" });
  const closed = pnl([...partial, row("trade_sell", "150", "150")], "0");
  assert.equal(closed.assets.length, 1);
  assert.deepEqual(closed.totals, { realized_usd: "-100.00", unrealized_usd: "0.00", total_usd: "-100.00" });
  assert.equal(closed.assets[0].basis_usd, "0.00");
  assert.equal(closed.assets[0].icon_url, metadata[0].icon_url, "closed assets retain their coin icon without a wallet holding");
  assert.deepEqual(validator.validate("pnl-response", closed).errors, []);
});

test("all indexed buys and sells of Blast coins contribute cost and proceeds regardless of venue", () => {
  const rows = [row("trade_buy", "100", "900"), row("trade_buy", "100", "100")];
  assert.deepEqual(pnl(rows, "200").totals, { realized_usd: "0.00", unrealized_usd: "-600.00", total_usd: "-600.00" });
  const sold = [...rows, row("trade_sell", "50", "1000")];
  assert.deepEqual(pnl(sold, "150").totals, { realized_usd: "750.00", unrealized_usd: "-450.00", total_usd: "300.00" });
  assert.equal(pnl([...sold, row("trade_sell", "50", "25")], "100").totals.realized_usd, "525.00");
});

test("presale claims use indexed commitments and deduct the refunded share", () => {
  const rows = [row("presale_commit", "0", "100", { quote_amount: "100" }), row("presale_claim", "80", null, { quote_refund: "20" }), row("trade_sell", "80", "160")];
  assert.equal(pnl(rows, "0").totals.realized_usd, "80.00");
});

test("stale marks, truncation, synchronization and transfer mismatches keep PNL unavailable", () => {
  const rows = [row("trade_buy", "100", "100"), row("trade_sell", "50", "100")];
  assert.equal(pnl([row("trade_sell", "100", "200")], "0").totals.realized_usd, null);
  assert.equal(pnl([row("presale_claim", "100", null)], "100").totals.total_usd, null, "A missing commitment is missing history, not a missing price");
  assert.equal(pnl([row("trade_buy", "100", "invalid")], "100").totals.total_usd, null);
  const stale = lifetimePnl({ rows, truncated: false }, wallet("50", "2", 120_001), metadata, NOW);
  assert.deepEqual(stale.totals, { realized_usd: "50.00", unrealized_usd: null, total_usd: null });
  assert.equal(pnl(rows, "25").totals.realized_usd, null);
  assert.equal(pnl(rows, "25").totals.unrealized_usd, null);
  assert.equal(pnl(rows, "25").assets[0].basis_usd, null);
  for (const status of ["syncing", "stale"] as const) {
    const snapshot = wallet("50");
    const answer = lifetimePnl({ rows, truncated: false }, { ...snapshot, sync: { ...snapshot.sync, status } }, metadata, NOW);
    assert.equal(answer.history_complete, false);
    assert.equal(answer.totals.realized_usd, null);
  }
  const truncated = lifetimePnl({ rows: [], truncated: true }, wallet("0"), [], NOW);
  assert.equal(truncated.history_complete, false);
  assert.equal(truncated.totals.total_usd, null);
});

test("missing historical USD values and current prices leave PnL since launch unavailable", () => {
  const rows = [row("trade_buy", "100", null), row("trade_sell", "40", null)];
  const snapshot = wallet("60", null);
  const answer = lifetimePnl({ rows, truncated: false }, {
    ...snapshot, holdings: snapshot.holdings.map((holding) => ({ ...holding, priceUnavailable: true })),
  }, metadata, NOW);
  assert.deepEqual(answer.totals, { realized_usd: null, unrealized_usd: null, total_usd: null });
  assert.equal(answer.assets[0].basis_usd, null);
  assert.equal(answer.assets[0].unrealized_usd, null);
  assert.equal(answer.assets[0].total_usd, null);
  assert.equal(answer.history_complete, true);
  assert.equal(rows[0].usd_value, null, "The source ledger remains unchanged");
  assert.deepEqual(validator.validate("pnl-response", answer).errors, []);
  assert.deepEqual(pnl(rows, "60", null).totals, answer.totals, "A missing mark is unknown even without an explicit unavailable flag");
  assert.equal(pnl([row("trade_buy", "100", "100")], "100", null).totals.total_usd, null, "Missing marks cannot establish a loss");
  assert.equal(pnl([row("trade_buy", "100", null)], "100").totals.total_usd, null, "Known marks cannot establish an unknown cost");
  assert.equal(pnl([row("trade_buy", "100", null), row("trade_sell", "100", "200")], "0").totals.realized_usd, null);
  assert.equal(pnl([row("trade_buy", "100", "100"), row("trade_sell", "100", null)], "0").totals.realized_usd, null);
});

test("unpriced presale commitments keep cost and PnL incomplete", () => {
  const rows = [row("presale_commit", "0", null, { quote_amount: "100" }), row("presale_claim", "80", null, { quote_refund: "20" })];
  assert.deepEqual(pnl(rows, "80", null).totals, { realized_usd: "0.00", unrealized_usd: null, total_usd: null });
  assert.equal(pnl(rows, "80", null).assets[0].basis_usd, null);
  assert.equal(pnl([row("presale_commit", "0", "100", { quote_amount: "100" }), ...rows], "80", null).assets[0].basis_usd, null);
});

test("zero basis and zero prices produce finite gains and full losses; cents round exactly", () => {
  assert.equal(pnl([row("trade_buy", "100", "0")], "100").totals.unrealized_usd, "200.00");
  assert.equal(pnl([row("trade_buy", "100", "100")], "100", "0").totals.unrealized_usd, "-100.00");
  assert.equal(pnl([row("trade_buy", "3", "0.1"), row("trade_sell", "3", "0.085")], "0").totals.realized_usd, "-0.02");
  assert.equal(pnl([row("trade_buy", "3", "0.1"), row("trade_sell", "3", "0.099")], "0").totals.realized_usd, "0.00");
});

test("per-asset totals add exactly across wallets and coins", () => {
  const rows = [row("trade_buy", "100", "100"), row("trade_sell", "100", "200", { actor: "wallet-b" }), row("trade_buy", "100", "100", { presale_id: OTHER }), row("trade_sell", "100", "25", { presale_id: OTHER })];
  const answer = lifetimePnl({ rows, truncated: false }, wallet("0"), [...metadata, { presale_id: OTHER, coin_type: `${OTHER}::coin::OTHER`, symbol: "OTHER", icon_url: null, decimals: 0 }], NOW);
  assert.deepEqual(answer.assets.map((asset) => asset.realized_usd), ["100.00", "-75.00"]);
  assert.equal(answer.totals.total_usd, "25.00");
  assert.equal(answer.assets[1].icon_url, null);
  assert.deepEqual(validator.validate("pnl-response", answer).errors, []);
  assert.equal(pnl([], "0").totals.total_usd, "0.00");
});

test("curve assets retain their launch identity and require one valid origin in the public contract", () => {
  const launch = OTHER;
  const answer = lifetimePnl({ rows: [row("trade_buy", "100", "100", { presale_id: launch })], truncated: false }, wallet("100"),
    [{ ...metadata[0], presale_id: null, launch_id: launch }], NOW);
  assert.equal(answer.assets[0].launch_id, launch);
  assert.equal(answer.assets[0].presale_id, null);
  assert.equal(answer.totals.total_usd, "100.00");
  assert.deepEqual(validator.validate("pnl-response", answer).errors, []);
  assert.ok(validator.validate("pnl-response", { ...answer, assets: [{ ...answer.assets[0], launch_id: undefined }] }).errors.length);
});


test("ambiguous transaction ordering makes PnL history incomplete", () => {
  const ambiguous = lifetimePnl({ rows: [row("trade_buy", "100", "100"), row("trade_sell", "100", "120", { accounting_complete: false })], truncated: false }, wallet("0"), metadata, NOW);
  assert.equal(ambiguous.history_complete, false);
  assert.equal(ambiguous.totals.total_usd, null);
});

test("an unresolved net-zero round trip cannot silently preserve a prior PnL figure", () => {
  const answer = pnl([
    row("trade_buy", "100", "100"),
    row("trade_unresolved", "0", null, { accounting_complete: false }),
  ], "100");
  assert.equal(answer.history_complete, false);
  assert.deepEqual(answer.totals, { realized_usd: null, unrealized_usd: null, total_usd: null });
});


test("curve all-venue PnL preserves launch identity while unknown costs and marks stay unavailable", () => {
  const launch = OTHER;
  const curveMetadata = [{ ...metadata[0], presale_id: null, launch_id: launch }];
  const rows = [row("trade_buy", "100", null, { presale_id: launch }), row("trade_sell", "40", "80", { presale_id: launch })];
  const answer = lifetimePnl({ rows, truncated: false }, wallet("60"), curveMetadata, NOW);
  assert.equal(answer.history_complete, true);
  assert.equal(answer.assets[0].launch_id, launch);
  assert.equal(answer.assets[0].basis_usd, null);
  assert.deepEqual(answer.totals, { realized_usd: null, unrealized_usd: null, total_usd: null });
  const knownCost = rows.map((trade) => trade.kind === "trade_buy" ? { ...trade, usd_value: "100" } : trade);
  const missingMark = lifetimePnl({ rows: knownCost, truncated: false }, wallet("60", null), curveMetadata, NOW);
  assert.deepEqual(missingMark.totals, { realized_usd: "40.00", unrealized_usd: null, total_usd: null });
  assert.deepEqual(validator.validate("pnl-response", missingMark).errors, []);
});
