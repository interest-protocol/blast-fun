import { fieldNumber } from "@blast/core/web/format.ts";
import { VESTING_UNITS, type VestingUnit } from "@blast/core/web/contracts/vesting.ts";
import type { CreateSaleDays } from "@blast/core/web/contracts/create.ts";

/** A recipient's wallet label: "Treasury" reads "Treasury wallet"; a name already ending in "wallet" (any case) is kept as it is. */
export function walletLabel(name: string): string {
  const trimmed = name.trim();
  return /wallet$/i.test(trimmed) ? trimmed : `${trimmed} wallet`;
}

export type FieldType = "text" | "sym" | "addr" | "money" | "int" | "pct";

/** What a field shows when it is not being typed in (the design's `fmtNum` / `fmtPct`). */
export function fieldText(type: FieldType, value: string | number, precision = 2): string {
  if (type === "pct") return String(Math.round(Number(value)) / 100);
  if (type === "money" || type === "int") return fieldNumber(Number(value), precision);
  return String(value);
}

const MONEY_MAX = 1e13;

/** What typing means for each kind of field (the design's input handler), within the saved draft's bounds. */
export function parseField(type: FieldType, raw: string, max = Number.MAX_SAFE_INTEGER, precision = 2): string | number {
  if (type === "sym") return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (type === "addr") return raw.trim();
  if (type === "text") return raw;
  const digits = raw.replace(type === "int" ? /[^0-9]/g : /[^0-9.]/g, "");
  if (type === "int") return Math.min(parseInt(digits, 10) || 0, max);
  const value = parseFloat(digits) || 0;
  if (type === "pct") return Math.min(Math.round(value * 100), 1_000_000);
  const scale = 10 ** precision;
  return Math.min(Math.round(value * scale) / scale, MONEY_MAX);
}

const pad2 = (value: number) => String(value).padStart(2, "0");

/** What the Raise step's Opens field shows: the draft's `start_ms` in the browser's time zone (a `datetime-local` value), empty for "when you publish". */
export function startFieldText(startMs: number | null): string {
  if (startMs === null) return "";
  const at = new Date(startMs);
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}T${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
}

/** The draft's `start_ms` from the Opens field (local time, as `datetime-local` gives it); null when it is cleared or not yet complete. */
export function parseStartField(raw: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(raw)) return null;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** A name's hue, 0 to 359 (the design's `crHue`): used by the generated coin mark. */
export const nameHue = (text: string): number => {
  let hue = 0;
  for (const char of text) hue = (hue * 31 + char.charCodeAt(0)) % 360;
  return hue;
};

/** The recommended cover: 3:1, matching the stored 1536 × 512 banner (packages/server sales/cover.ts); twice that stays sharp on dense screens. */
export const COVER_GUIDE = Object.freeze({ width: 3_072, height: 1_024, minWidth: 1_536, minHeight: 512 });

/**
 * A non-blocking note about a picked cover's own pixels (read in the browser
 * before upload): too small, or far from 3:1. Null when it fits the guide.
 */
export function coverHint(width: number, height: number): string | null {
  if (!(width > 0 && height > 0)) return null;
  const small = width < COVER_GUIDE.minWidth || height < COVER_GUIDE.minHeight;
  const ratio = width / height / (COVER_GUIDE.width / COVER_GUIDE.height);
  const shape = ratio < 0.9 || ratio > 1.1;
  if (!small && !shape) return null;
  const size = `${width} × ${height} px`;
  const minimum = `${COVER_GUIDE.minWidth} × ${COVER_GUIDE.minHeight} px`;
  if (small && shape) return `This image is ${size}. Use at least ${minimum} at about 3:1 so it stays sharp and nothing important is cropped.`;
  if (small) return `This image is ${size}. Use at least ${minimum} so it stays sharp.`;
  return `This image is ${size}, not about 3:1, so more of it will be cropped.`;
}

export const LOGO_GUIDE = "512 × 512 px · square PNG, JPG or WebP, up to 2 MB";

const OFFERED_UNITS: readonly VestingUnit[] = VESTING_UNITS.filter((unit) => unit !== "seconds" && unit !== "milliseconds");

/** The vesting units a picker offers: months to minutes, plus a saved draft's own finer unit so it still loads as saved. */
export function vestingUnitOptions(current: VestingUnit): readonly VestingUnit[] {
  return OFFERED_UNITS.includes(current) ? OFFERED_UNITS : [...OFFERED_UNITS, current];
}

const OFFERED_SALE_DAYS: readonly CreateSaleDays[] = [1, 3, 7];

/** The sale lengths "Runs for" offers: 1, 3 or 7 days, plus a saved draft's own longer length (14 days) so it still loads as saved. */
export function saleDayOptions(current: CreateSaleDays): readonly CreateSaleDays[] {
  return OFFERED_SALE_DAYS.includes(current) ? OFFERED_SALE_DAYS : [...OFFERED_SALE_DAYS, current];
}
