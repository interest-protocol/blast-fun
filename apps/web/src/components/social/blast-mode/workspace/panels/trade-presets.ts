import { SELL_PRESETS, sellPresetAmount } from "#web/components/social/trade/trade-ticket.ts";
import type { TradeDraft } from "#web/components/social/trade/trade-ticket.ts";
import { compareExact } from "@blast/core/web/exact-amount.ts";
import { amountInAtoms, presetDraft, typedUsd, type TradeFacts } from "./trade-model";

export type TradePresets = Readonly<{ buy: readonly string[]; sell: readonly string[] }>;
export const DEFAULT_TRADE_PRESETS: TradePresets = { buy: ["50", "100", "500", "max"], sell: SELL_PRESETS.map(([value]) => value) };
export const TRADE_PRESET_SLOTS = [1, 2, 3, 4] as const;
export const TRADE_PRESETS_KEY = "blast.workspace.trade-presets.v1";

/** Bound settings at the storage boundary; amounts stay decimal strings. */
export function validateTradePresets(value: unknown): value is TradePresets {
  if (!value || typeof value !== "object" || !("buy" in value) || !("sell" in value)) return false;
  return validRow(value.buy, "buy") && validRow(value.sell, "sell");
}

function validRow(value: unknown, side: "buy" | "sell") {
  return Array.isArray(value) && value.length === 4 && value.every(item => typeof item === "string" && tradePresetError(side, item) === null);
}

/** The longest preset the rules accept: nine whole digits, a point and two decimals. */
export const TRADE_PRESET_MAX_CHARS = 12;

/** What is wrong with one preset, in a few words for the line under its field; null when it is valid. */
export function tradePresetError(side: "buy" | "sell", value: string): string | null {
  if (value === "max") return null;
  if (value === "") return "Enter a value";
  if (!/^\d+(?:\.\d+)?$/.test(value)) return "Number or max";
  if (/\.\d{3,}$/.test(value)) return "Max 2 decimals";
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(value)) return "Too large";
  if (Number(value) <= 0) return "Above 0";
  if (side === "sell" && Number(value) > 100) return "Up to 100";
  return null;
}

export function readTradePresets(raw: string | null): TradePresets {
  try { const value: unknown = JSON.parse(raw ?? "null"); return validateTradePresets(value) ? value : DEFAULT_TRADE_PRESETS; }
  catch { return DEFAULT_TRADE_PRESETS; }
}

export function tradePresetDraft(side: "buy" | "sell", value: string, facts: TradeFacts): TradeDraft | null {
  if (side === "buy") return presetDraft(value, side, facts);
  if (facts.held === null || facts.held <= 0n || facts.decimals === null) return null;
  return { side, ...sellPresetAmount(value, { atoms: facts.held, decimals: facts.decimals }) };
}

export function isTradePresetSelected(draft: TradeDraft, value: string, facts: TradeFacts) {
  if (draft.side === "buy") {
    if (value === "max") return draft.mode === "all";
    return draft.mode === "typed" && compareExact(typedUsd(draft.typed), typedUsd(value)) === 0;
  }
  const selected = tradePresetDraft("sell", value, facts);
  if (!selected || draft.unit !== "token") return false;
  const atoms = amountInAtoms(selected, facts);
  return atoms !== null && atoms > 0n && atoms === amountInAtoms(draft, facts);
}

export function tradePresetLabel(side: "buy" | "sell", value: string) {
  return value === "max" ? "Max" : side === "sell" ? `${value}%` : `$${value}`;
}
