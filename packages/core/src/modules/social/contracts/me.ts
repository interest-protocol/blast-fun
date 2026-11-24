import { z } from "zod";

import { socialAddressSchema, socialCallsignSchema, socialUuidSchema } from "./primitives.ts";

/**
 * `GET /api/social/me` (200, `Cache-Control: private, no-store`): the caller's
 * Blast Account, or `account: null` when the signed-in caller has none. Privy
 * DIDs and X subjects never appear in it. JSON Schema:
 * `schemas/me-response.schema.json`.
 */

export const SOCIAL_ACCOUNT_KINDS = ["member", "new"] as const;
/** `member` extends a Mission Control profile; `new` holds its own callsign and Privy DID. */
export type SocialAccountKind = (typeof SOCIAL_ACCOUNT_KINDS)[number];

export const SOCIAL_PRIVACY = ["public", "private"] as const;
export type SocialPrivacy = (typeof SOCIAL_PRIVACY)[number];

export const SOCIAL_WALLET_KINDS = ["embedded", "slush", "external"] as const;
export type SocialWalletKind = (typeof SOCIAL_WALLET_KINDS)[number];

export const meResponseSchemaMetadata = z.registry<z.core.JSONSchemaMeta>();
const nullableText = z.xor([z.null(), z.string().min(1)])
  .register(meResponseSchemaMetadata, { id: "nullableText" });
const millis = z.number().nonnegative().refine(Number.isInteger).meta({ type: "integer" })
  .register(meResponseSchemaMetadata, { id: "millis", type: "integer" });

export const socialAccountWalletSchema = z.strictObject({
  address: socialAddressSchema,
  kind: z.enum(SOCIAL_WALLET_KINDS),
  linked_at_ms: millis,
}).register(meResponseSchemaMetadata, { id: "wallet" });

export type SocialAccountWallet = Readonly<z.infer<typeof socialAccountWalletSchema>>;

export const socialMeAccountSchema = z.strictObject({
  account_id: socialUuidSchema,
  kind: z.enum(SOCIAL_ACCOUNT_KINDS),
  callsign: socialCallsignSchema,
  display_name: nullableText,
  avatar_url: nullableText,
  x_handle: nullableText,
  verified: z.boolean().register(meResponseSchemaMetadata, { description: "OA-8: the account has a linked X account (a Mission Control member always has)." }),
  onboarding: z.strictObject({ shown: z.boolean(), completed: z.boolean() }),
  privacy: z.enum(SOCIAL_PRIVACY),
  sharing_since_ms: z.xor([z.null(), millis]),
  wallets: z.array(socialAccountWalletSchema),
}).register(meResponseSchemaMetadata, { id: "account" });

export type SocialMeAccount = Readonly<Omit<z.infer<typeof socialMeAccountSchema>, "wallets"> & {
  wallets: readonly SocialAccountWallet[];
}>;

/** An account as routes see it once resolved: the `me` account without its wallets. */
export type SocialAccount = Omit<SocialMeAccount, "wallets">;

export const socialMeResponseSchema = z.strictObject({
  account: z.xor([z.null(), socialMeAccountSchema]),
}).register(meResponseSchemaMetadata, {
  title: "Social account of the caller",
  description: "GET /api/social/me 200. Privy DIDs and X subjects never appear.",
});

export type SocialMeResponse = Readonly<{ account: SocialMeAccount | null }>;

export const SOCIAL_ME_ROUTE = "GET /api/social/me";
export const SOCIAL_ME_PATH = "/api/social/me";

export const socialXHandleRefreshSchema = z.strictObject({ updated: z.boolean() });
