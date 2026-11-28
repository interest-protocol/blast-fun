import { z } from "zod";

import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { boundedFetch } from "@blast/server/lib/bounded-fetch.ts";
import { createSemaphore } from "@blast/server/lib/concurrency.ts";

const userResponse = z.object({
  data: z.object({
    id: z.string().regex(/^[1-9][0-9]{0,19}$/),
    username: z.string().regex(/^[A-Za-z0-9_]{1,15}$/),
  }),
});
const absentResponse = z.object({
  errors: z.array(z.object({
    type: z.enum(["https://api.x.com/2/problems/resource-not-found", "https://api.twitter.com/2/problems/resource-not-found"]),
  })).min(1),
});

/** Coalesce simultaneous submissions for the same spelling without keeping a stale handle-to-ID cache. */
export function creatorXLookup(token: string | null, concurrency: number, transport?: typeof fetch) {
  const fetchX = boundedFetch(4_000, transport);
  const slots = createSemaphore(concurrency);
  const pending = new Map<string, Promise<string | null>>();

  async function lookup(handle: string): Promise<string | null> {
    if (!token) throw new SocialRouteError("creator_x_unavailable");
    const release = await slots.acquire(0);
    try {
      const response = await fetchX(`https://api.x.com/2/users/by/username/${encodeURIComponent(handle)}`, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new SocialRouteError("creator_x_unavailable");
      const body: unknown = await response.json();
      const user = userResponse.safeParse(body);
      if (user.success && user.data.data.username.toLowerCase() === handle) return user.data.data.id;
      if (absentResponse.safeParse(body).success) return null;
      throw new SocialRouteError("creator_x_unavailable");
    } finally {
      release();
    }
  }

  return function resolve(handle: string): Promise<string | null> {
    const key = handle.toLowerCase();
    const existing = pending.get(key);
    if (existing) return existing;
    const result = lookup(key)
      .catch(() => { throw new SocialRouteError("creator_x_unavailable"); })
      .finally(() => pending.delete(key));
    pending.set(key, result);
    return result;
  };
}
