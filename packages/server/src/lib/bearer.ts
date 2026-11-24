import { createHash, timingSafeEqual } from "node:crypto";

import { MINIMUM_SECRET_LENGTH } from "@blast/core/lib/config/secret.ts";

/**
 * Whether `Authorization` is exactly `Bearer <secret>` (the cron secret, the
 * operator token). Compare digests so the check takes the same time whatever
 * the header holds. A missing or short secret refuses every request instead of
 * accepting an empty bearer.
 */
export function bearerMatches(request: Request, secret: string | undefined): boolean {
  if (!secret || secret.length < MINIMUM_SECRET_LENGTH) {
    return false;
  }
  const presented = createHash("sha256")
    .update(request.headers.get("authorization") ?? "")
    .digest();
  const expected = createHash("sha256").update(`Bearer ${secret}`).digest();
  return timingSafeEqual(presented, expected);
}
