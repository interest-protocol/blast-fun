import { createHash } from "node:crypto";
import { z } from "zod";
import { partnerIdSchema } from "@blast/server/modules/partner-api-keys/contracts.ts";

const positive = (maximum: number) => z.number().int().min(1).max(maximum);
const reservation = z.strictObject({
  id: partnerIdSchema,
  requestsPerMinute: positive(2_147_483_647),
  keyRequestsPerMinute: positive(2_147_483_647),
  maxInflight: positive(256),
  queueLimit: positive(128),
});
const schema = z
  .strictObject({
    maxReplicas: positive(32),
    internalMaxInflight: positive(256),
    maxEntries: positive(20_000),
    maxBytes: positive(4_194_304),
    maxOrigins: positive(20_000),
    safeRequestsPerMinute: positive(2_147_483_647),
    // Explicit measured-envelope reference, never an inferred production capacity.
    evidence: z.string().min(1).max(128),
    reserves: z.strictObject({
      preflight: positive(2_147_483_647),
      anonymous: positive(2_147_483_647),
      unknown: positive(2_147_483_647),
      admin: positive(2_147_483_647),
      internal: positive(2_147_483_647),
    }),
    tenants: z.array(reservation).min(1).max(128),
    // Optional sub-limit of reserves.preflight per client network (IPv6 /64). Absent
    // keeps every existing fingerprint; setting it is a config change that rebuilds the map.
    preflightPerIp: positive(2_147_483_647).optional(),
    classifierInflight: positive(64),
    queueWaitMs: positive(500),
  })
  .superRefine((value, context) => {
    if (value.internalMaxInflight < value.maxReplicas)
      context.addIssue({
        code: "custom",
        message: "Internal reservation cannot be subdivided across replicas.",
      });
    if (
      value.preflightPerIp !== undefined &&
      value.preflightPerIp > value.reserves.preflight
    )
      context.addIssue({
        code: "custom",
        message:
          "Per-network preflight limit cannot exceed the preflight reserve.",
      });
    const ids = new Set<string>();
    for (const tenant of value.tenants) {
      if (ids.has(tenant.id) || tenant.maxInflight < value.maxReplicas)
        context.addIssue({
          code: "custom",
          message: "Duplicate or unsubdividable tenant reservation.",
        });
      ids.add(tenant.id);
    }
    const total =
      value.tenants.reduce((sum, tenant) => sum + tenant.requestsPerMinute, 0) +
      Object.values(value.reserves).reduce((sum, number) => sum + number, 0);
    if (total > value.safeRequestsPerMinute)
      context.addIssue({
        code: "custom",
        message: "Reservations exceed the declared measured envelope.",
      });
  });
export type PartnerCapacity = z.infer<typeof schema>;
export class PartnerCapacityError extends Error {
  constructor() {
    super("Partner entitlement or recognition capacity is insufficient.");
  }
}
export function partnerCapacity(value: string | undefined): PartnerCapacity {
  if (!value || value.length > 65_536)
    throw new Error("Explicit BLAST_PARTNER_CAPACITY_CONFIG is required.");
  return schema.parse(JSON.parse(value));
}
/**
 * One client network's share of the preflight reserve. The default (a quarter)
 * is unmeasured: four networks can still exhaust the reserve, and a large shared
 * NAT may meet it first. Record the effective value with any capacity evidence.
 */
export function preflightPerIpLimit(capacity: PartnerCapacity): number {
  return (
    capacity.preflightPerIp ??
    Math.max(1, Math.floor(capacity.reserves.preflight / 4))
  );
}
export function capacityFingerprint(capacity: PartnerCapacity): string {
  return createHash("sha256").update(JSON.stringify(capacity)).digest("hex");
}
export type Entitlement = {
  partner_id: string;
  tier: string;
  requests_per_minute: number | null;
};
export function assertEntitlementCapacity(
  capacity: PartnerCapacity,
  keys: readonly Entitlement[],
): void {
  if (keys.length > capacity.maxEntries) throw new PartnerCapacityError();
  const totals = new Map<string, number>();
  let internal = 0;
  for (const key of keys) {
    const tenant = capacity.tenants.find((item) => item.id === key.partner_id);
    if (!tenant) throw new PartnerCapacityError();
    if (key.tier === "internal") {
      internal++;
      continue;
    }
    const minute = key.requests_per_minute;
    if (
      !Number.isSafeInteger(minute) ||
      minute! < 1 ||
      minute! > tenant.keyRequestsPerMinute
    )
      throw new PartnerCapacityError();
    totals.set(key.partner_id, (totals.get(key.partner_id) ?? 0) + minute!);
  }
  for (const tenant of capacity.tenants)
    if ((totals.get(tenant.id) ?? 0) > tenant.requestsPerMinute)
      throw new PartnerCapacityError();
  // Internal keys have no commercial entitlement; their operational lane stays bounded.
  if (internal && capacity.reserves.internal < 1)
    throw new PartnerCapacityError();
}
