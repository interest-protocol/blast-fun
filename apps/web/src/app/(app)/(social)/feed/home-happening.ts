import "server-only";

import { connection } from "next/server";
import { cache } from "react";

import { recordMetric } from "@blast/core/lib/metrics.ts";
import type { SocialHappeningResponse } from "@blast/core/modules/social/contracts/happening.ts";
import { readHappeningFromBackend } from "#web/lib/backend-api/social-reads.ts";

/** Share one Home activity read between mixed Discover and the Presales section. */
export const homeHappening = cache(async (): Promise<Readonly<{ read: SocialHappeningResponse | null; nowMs: number }>> => {
  await connection();
  try {
    return { read: await readHappeningFromBackend(), nowMs: Date.now() };
  } catch {
    recordMetric("social.home_happening", { outcome: "error" });
    return { read: null, nowMs: Date.now() };
  }
});
