import Decimal from "decimal.js";

/**
 * Exact decimal handling for USD strings as PostgreSQL renders `numeric`
 * (`-?digits[.digits]`, never an exponent). Values are compared and rounded
 * without binary floating-point arithmetic. Comparison and explicit
 * decimal-place formatting preserve all input digits without relying on
 * Decimal's global arithmetic precision.
 */

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

function decimal(value: string): Decimal {
  if (!DECIMAL.test(value)) throw new TypeError(`Not a decimal: ${JSON.stringify(value)}.`);
  return new Decimal(value);
}

/** -1, 0 or 1 as `a` is less than, equal to or greater than `b`. */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const order = decimal(a).comparedTo(decimal(b));
  return order < 0 ? -1 : order > 0 ? 1 : 0;
}

/** `value` with exactly two places, rounded half away from zero (as PostgreSQL's `round(numeric, 2)`). */
export function toUsd(value: string): string {
  const text = decimal(value).toFixed(2, Decimal.ROUND_HALF_UP);
  return text === "-0.00" ? "0.00" : text;
}
