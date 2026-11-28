import { divideExact, exactAtoms, exactDecimal, exactText, multiplyExact, subtractExact } from "@blast/core/web/exact-amount.ts";
import type { CostBasisFigures } from "@blast/core/web/contracts/portfolio.ts";
import { readableUsd } from "#web/lib/market-format.ts";

/** A holder's coin row: the account's cost basis and its balance, in atoms. */
export type HeldCoin = CostBasisFigures & Readonly<{ balance: string }>;

/** "In at $12K · +$340 · +600%": the market cap the holder bought in at, and the P&L at today's. */
export type HolderLine = Readonly<{ entry: string; pnl: string; percent: string; tone: "up" | "down" | "flat" }>;

/**
 * The holder's entry and P&L in market-cap terms. The average cost per coin times the supply in
 * circulation is the market cap the holder bought in at; the balance's share of today's market cap
 * is its value. Null for a non-holder, an incomplete cost basis, or without today's market cap.
 */
export function holderLine(held: HeldCoin | null | undefined, supplyAtoms: bigint | string, capUsd: string | null): HolderLine | null {
  if (held?.basis_complete !== true) return null;
  const basis = exactDecimal(held.basis_usd);
  const balance = exactAtoms(held.balance, 0);
  const supply = exactAtoms(supplyAtoms, 0);
  const cap = exactDecimal(capUsd);
  if (!basis?.n || !balance?.n || !supply?.n || !cap) return null;
  const entry = divideExact(multiplyExact(basis, supply), balance);
  const value = divideExact(multiplyExact(cap, balance), supply);
  if (!entry || !value) return null;
  const gain = subtractExact(value, basis);
  const loss = gain ? null : subtractExact(basis, value);
  const move = gain ?? loss;
  if (!move) return null;
  const tone = move.n === 0n ? "flat" : gain ? "up" : "down";
  const sign = tone === "up" ? "+" : tone === "down" ? "−" : "";
  const ratio = divideExact(move, basis, 4);
  const percent = ratio ? Math.round(Number(exactText(ratio)) * 100) : 0;
  return {
    entry: readableUsd(exactText(entry)),
    pnl: `${sign}${readableUsd(exactText(move))}`,
    percent: `${sign}${percent.toLocaleString("en-US")}%`,
    tone,
  };
}
