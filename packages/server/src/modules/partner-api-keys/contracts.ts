import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

export const partnerIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const partnerKeyIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const partnerKeyLabelSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._:@-]{0,99}$/);
const partnerApiKeySchema = z.string().regex(/^blast_pk_[A-Za-z0-9_-]{43}$/);
export const partnerOriginsSchema = z.array(z.string().max(256).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && !url.hostname.includes("*");
  } catch { return false; }
})).max(20).refine((origins) => new Set(origins).size === origins.length);

export const partnerSchema = z.object({ id: partnerIdSchema, origins: partnerOriginsSchema });
export type Partner = z.infer<typeof partnerSchema>;

const quotaLimit = z.number().int().min(1).max(2_147_483_647);
export const partnerKeyPolicySchema = z.discriminatedUnion("tier", [
  z.strictObject({ tier: z.literal("standard") }),
  z.strictObject({ tier: z.literal("custom"), requestsPerMinute: quotaLimit, requestsPerDay: quotaLimit })
    .refine((policy) => policy.requestsPerDay >= policy.requestsPerMinute),
  z.strictObject({ tier: z.literal("internal") }),
]);
export type PartnerKeyPolicy = z.infer<typeof partnerKeyPolicySchema>;
export const partnerGrantSchema = partnerSchema.extend({
  keyId: z.uuid(),
  policy: partnerKeyPolicySchema,
});
export type PartnerGrant = z.infer<typeof partnerGrantSchema>;

export interface PartnerKeyReader {
  verify(key: string): Promise<PartnerGrant | null>;
  allowsOrigin(origin: string): Promise<boolean>;
}

export function isPartnerApiKey(key: string): boolean {
  return partnerApiKeySchema.safeParse(key).success;
}

export function generatePartnerApiKey(): string {
  return `blast_pk_${randomBytes(32).toString("base64url")}`;
}

export function hashPartnerApiKey(key: string): Buffer {
  return createHash("sha256").update(key).digest();
}
