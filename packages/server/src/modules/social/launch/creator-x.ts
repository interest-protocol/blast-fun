import { z } from "zod";

import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { boundedFetch } from "@blast/server/lib/bounded-fetch.ts";
import { createSemaphore } from "@blast/server/lib/concurrency.ts";

const socialDataProfile = z.object({
  id_str: z.string().regex(/^[1-9][0-9]{0,19}$/),
  screen_name: z.string().regex(/^[A-Za-z0-9_]{1,15}$/),
});

/** Coalesce simultaneous submissions for the same spelling without keeping a stale handle-to-ID cache. */
export function creatorXLookup(apiKey: string | null, concurrency: number, transport?: typeof fetch) {
  const fetchProfile = boundedFetch(4_000, transport);
  const slots = createSemaphore(concurrency);
  const pending = new Map<string, Promise<string | null>>();

  async function lookup(handle: string): Promise<string | null> {
    if (!apiKey) throw new SocialRouteError("creator_x_unavailable");
    const release = await slots.acquire(0);
    try {
      const response = await fetchProfile(`https://api.socialdata.tools/twitter/user/${encodeURIComponent(handle)}`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        redirect: "error",
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new SocialRouteError("creator_x_unavailable");
      const user = socialDataProfile.safeParse(await response.json());
      // SocialData also accepts numeric IDs at this path. Check the returned handle.
      if (!user.success || user.data.screen_name.toLowerCase() !== handle) {
        throw new SocialRouteError("creator_x_unavailable");
      }
      return user.data.id_str;
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
