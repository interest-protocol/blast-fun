import { HEALTH_SHARED_MS } from "@blast/core/modules/service-health/contracts.ts";
import { serviceHealth } from "./runtime.ts";

/**
 * The CDN may keep a health answer for what is left of its `HEALTH_SHARED_MS`
 * since it was checked, never longer, so a warning shows at most 5 s late.
 * Browsers keep nothing (`max-age=0`, and the client reads with `no-store`).
 * Only a 200 carries this header: an error answer comes from the backend's
 * error handler, which never caches.
 */
export function healthCacheControl(checkedAt: number, nowMs: number): string {
  const seconds = Math.floor((HEALTH_SHARED_MS - (nowMs - checkedAt)) / 1_000);
  return seconds > 0 ? `public, max-age=0, s-maxage=${Math.min(seconds, HEALTH_SHARED_MS / 1_000)}` : "no-store";
}

export async function serviceHealthRoute(): Promise<Response> {
  const health = await serviceHealth();
  return Response.json(health, { headers: { "Cache-Control": healthCacheControl(health.checkedAt, Date.now()) } });
}
export { serviceHealthRoute as GET };
