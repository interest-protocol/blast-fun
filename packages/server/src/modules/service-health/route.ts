import { HEALTH_SHARED_MS } from "@blast/core/modules/service-health/contracts.ts";
import { serviceHealth } from "./runtime.ts";

/** The CDN starts its clock when the answer reaches it; this second covers the trip there. */
const HEALTH_TRANSIT_MS = 1_000;

/**
 * The CDN may keep a health answer for what is left of its `HEALTH_SHARED_MS`
 * since it was checked, less the trip to the CDN, so a warning shows at most
 * 5 s late. Browsers keep nothing (`max-age=0`, and the client reads with
 * `no-store`). Only a 200 carries this header: an error answer comes from the
 * backend's error handler, which never caches.
 */
export function healthCacheControl(checkedAt: number, nowMs: number): string {
  const ageMs = Math.max(0, nowMs - checkedAt);
  const seconds = Math.floor((HEALTH_SHARED_MS - HEALTH_TRANSIT_MS - ageMs) / 1_000);
  return seconds > 0 ? `public, max-age=0, s-maxage=${seconds}` : "no-store";
}

export async function serviceHealthRoute(): Promise<Response> {
  const health = await serviceHealth();
  return Response.json(health, { headers: { "Cache-Control": healthCacheControl(health.checkedAt, Date.now()) } });
}
export { serviceHealthRoute as GET };
