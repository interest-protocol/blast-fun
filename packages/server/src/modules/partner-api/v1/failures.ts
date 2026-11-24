import { firstPartyReadRoute } from "@blast/server/modules/partner-api/v1/paths.ts";

/** Public browser adapters keep their published family-specific retry codes. */
export function firstPartyReadCodes(canonicalPath: string) {
  const route = firstPartyReadRoute(canonicalPath);
  if (route?.name === "market") return { rateLimited: "rate_limited", unavailable: "unavailable" };
  if (route && ["discovery", "search", "wallet_launches", "defillama"].includes(route.name)) {
    return { rateLimited: "LAUNCHPAD_RATE_LIMITED", unavailable: "LAUNCHPAD_READ_UNAVAILABLE" };
  }
  return { rateLimited: "rate_limited", unavailable: "service_unavailable" };
}
