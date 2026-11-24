import { z } from "zod";

import type { SocialErrorCode } from "@blast/core/modules/social/contracts/errors.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";

/** Keep route error envelopes stable while schemas own boundary validation. */
export function socialInput<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  code: SocialErrorCode = "invalid_request",
): z.output<Schema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new SocialRouteError(code);
  return parsed.data;
}

/** Validate one query/path value without changing the parameter error envelope. */
export function socialParameter<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  parameter: string,
): z.output<Schema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new SocialRouteError("invalid_parameter", { extra: { parameter } });
  return parsed.data;
}

/** Query names that occur at most once; unrelated query keys remain untouched. */
export function socialSingle(params: URLSearchParams, name: string): string | null {
  return socialParameter(z.array(z.string()).max(1), params.getAll(name), name)[0] ?? null;
}
