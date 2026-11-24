import { z } from "zod";

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * A whole-number setting: unset or blank is `fallback`; anything else must be
 * an integer from `minimum` to `maximum`. Errors name the variable, never the value.
 */
export function boundedInteger(
  environment: Environment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!z.number().int().min(minimum).max(maximum).safeParse(value).success) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}
