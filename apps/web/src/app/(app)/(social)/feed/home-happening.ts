import "server-only";

import { connection } from "next/server";
import { cache } from "react";

import { recordMetric } from "@blast/core/lib/metrics.ts";
import type { SocialHappeningResponse } from "@blast/core/modules/social/contracts/happening.ts";
import { readHappeningFromBackend } from "#web/lib/backend-api/social-reads.ts";

/**
 * Home's happening read for one request, shared by the page (the ≤1219 live
 * card and Today on Blast) and the `@rail` slot (the right column): one read
 * on the replica per page view. A failed read leaves the parts to the browser,
 * which reads `GET /api/social/happening` on its first signal.
 */
export const homeHappening = cache(async (): Promise<Readonly<{ read: SocialHappeningResponse | null; nowMs: number }>> => {
  await connection();
  try {
    return { read: await readHappeningFromBackend(), nowMs: Date.now() };
  } catch {
    recordMetric("social.home_happening", { outcome: "error" });
    return { read: null, nowMs: Date.now() };
  }
});
