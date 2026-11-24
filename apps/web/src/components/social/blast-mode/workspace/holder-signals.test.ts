import assert from "node:assert/strict";
import test from "node:test";
import type { HomeHolder } from "@blast/core/modules/social/contracts/home.ts";
import { proofCoins, proofTraders } from "../../../../../test/fixtures/workspace/redesign-fixtures";
import { holderSignals, publicPnlRanks } from "./holder-signals";

const holders = proofCoins.KSTL.top_holders!.holders;
const follows = (callsign: string) => callsign === "inesduarte";

test("signals match positive current balances, explicit KOL membership and public global PnL ranks", () => {
  const signals = holderSignals(holders, new Set(["maralin"]), follows, publicPnlRanks(proofTraders.traders));
  const mara = signals.find(row => row.actor.callsign === "maralin")!;
  assert.deepEqual([mara.kol, mara.followed, mara.pnlRank], [true, false, 3]);
  const ines = signals.find(row => row.actor.callsign === "inesduarte")!;
  assert.deepEqual([ines.kol, ines.followed, ines.pnlRank], [false, true, 1]);
  assert.equal(holderSignals(holders, new Set(), () => undefined, new Map()).length, 0, "verification alone never means KOL and unknown follows never mean friends");
});

test("wallets, zero, negative and malformed balances never become social holding evidence; duplicates stay one person", () => {
  const holder = holders.find(row => row.actor.type === "account")!;
  const rows: HomeHolder[] = ["0", "-1", "NaN", "1.5", ""].map(balance => ({ ...holder, balance }));
  assert.deepEqual(holderSignals(rows, new Set(), () => true, new Map()), []);
  assert.equal(holderSignals([{ ...holder, balance: "900719925474099300100" }, holder], new Set(), () => true, new Map()).length, 1);
  assert.deepEqual(holderSignals(holders.filter(row => row.actor.type === "address"), new Set(), () => true, new Map()), []);
});

test("PnL recognition excludes withheld, unavailable and unranked performance, with no price or activity inference", () => {
  const trader = proofTraders.traders[0]!;
  const variants = [
    { ...trader, performance_public: false },
    { ...trader, portfolio: { ...trader.portfolio, pnl_usd: null } },
    { ...trader, rank: null }, { ...trader, rank: 11 }, { ...trader, rank: 0 },
  ];
  assert.equal(publicPnlRanks(variants).size, 0);
  assert.deepEqual(holderSignals([], new Set(["maralin"]), () => true, publicPnlRanks(proofTraders.traders)), []);
});
