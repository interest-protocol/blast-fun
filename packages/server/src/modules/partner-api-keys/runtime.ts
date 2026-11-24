import {
  DEFAULT_RATE_POLICIES,
  LAUNCHPAD_MARKET_RATE_BUCKETS,
  type RateBucket,
  type RatePolicy,
} from "@blast/core/lib/web-security/rate-limits.ts";
import { partnerKeyPolicySchema, type PartnerKeyPolicy } from "@blast/server/modules/partner-api-keys/contracts.ts";

export function partnerRatePolicies(policy: PartnerKeyPolicy) {
  const input = partnerKeyPolicySchema.parse(policy);
  if (input.tier === "internal") throw new Error("Internal keys do not consume partner quotas");
  return {
    ...DEFAULT_RATE_POLICIES,
    partner_read: {
      ...DEFAULT_RATE_POLICIES.partner_read,
      windows: input.tier === "standard" ? DEFAULT_RATE_POLICIES.partner_read.windows : [
        { limit: input.requestsPerMinute, windowSeconds: 60 },
        { limit: input.requestsPerDay, windowSeconds: 86_400 },
      ],
    },
  };
}

const PARTNER_ENDPOINT_BUCKETS = [
  "social_read_presales", "social_read_prices", "launchpad_search", "launchpad_discovery", "launchpad_wallet_launches", "defillama_read", "presale_proof",
  ...LAUNCHPAD_MARKET_RATE_BUCKETS,
] as const;

/** Extra endpoint cost budgets belong to a verified key, not a shared NAT. */
export const PARTNER_ENDPOINT_POLICIES: Readonly<Record<RateBucket, RatePolicy>> = {
  ...DEFAULT_RATE_POLICIES,
  ...Object.fromEntries(PARTNER_ENDPOINT_BUCKETS.map((bucket) => [
    bucket, { ...DEFAULT_RATE_POLICIES[bucket], subjectScope: "api_key" as const },
  ])),
};
