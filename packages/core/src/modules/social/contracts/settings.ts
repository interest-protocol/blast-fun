import { z } from "zod";

import { financialCoinTypeSchema } from "./financial-wire.ts";
import { SOCIAL_PRIVACY } from "./me.ts";

/**
 * The caller's settings (canonical UI §7), account required.
 *
 * `GET /api/social/me/settings` (no bucket, `private, no-store`): every
 * stored setting, `SocialSettingsResponse`.
 *
 * `PUT /api/social/me/settings` (bucket `social_account_update`): any of the
 * fields below; a client sends only the ones that changed, and the answer is
 * every stored setting after the change. JSON Schemas:
 * `schemas/settings-request.schema.json` and
 * `schemas/settings-response.schema.json`.
 *
 * - `private: true` makes the account private and clears `sharing_since`.
 * - `private: false` on a private account makes it public and starts sharing
 *   at the server's time; on a public account it changes nothing.
 * - `public_portfolio` (OA-10) lets others read the portfolio through
 *   `GET /api/social/profiles/{callsign}/portfolio`, which also requires a
 *   public account. Off by default.
 * - `commit_too_coin_type` is the coin a hold-to-commit pays with: a canonical
 *   coin type, or null for each sale's own quote coin (the default). A hold
 *   never pays with another coin when this one is not held.
 * - `explorer` is where the account's transaction links open.
 * - `sound` (R3-12; off until chosen, amending OA-25 Q3a) is the Feel layer's
 *   "Sound" switch. `GET` answers **null while the account has never chosen**
 *   — sound is then off, as for a visitor — and `true`/`false` once it has.
 *   `PUT` takes only a boolean: a choice is made by the reader flipping a
 *   switch (or by a session handing the account the choice this device
 *   already holds), never reset to "no choice". The browser's live flag is per
 *   device; a session copies an explicit choice onto the device when it
 *   starts, and each toggle while signed in writes it back.
 * - `notifications` (OA-11) sets any of the eight switches; the others keep
 *   their value. An account that never changed one has them all on.
 */
export const SOCIAL_EXPLORERS = ["suiscan", "suivision"] as const;
export type SocialExplorer = (typeof SOCIAL_EXPLORERS)[number];
/** The design's default (FEATURE-MAP §20). */
export const DEFAULT_SOCIAL_EXPLORER: SocialExplorer = "suiscan";

/**
 * The notification switches, in the design's order: "Opens soon", "80%
 * filled", "Last hour", "Funded", "Claims open", "Unlocks", "People you
 * follow", "Up since your call".
 */
export const NOTIFICATION_PREFERENCE_KEYS = [
  "opens_soon",
  "almost_full",
  "last_hour",
  "funded",
  "claims_open",
  "unlocks",
  "people_you_follow",
  "call_moves",
] as const;
export type NotificationPreferenceKey = (typeof NOTIFICATION_PREFERENCE_KEYS)[number];
export type NotificationPreferences = Readonly<Record<NotificationPreferenceKey, boolean>>;

/** Every switch on: an account's preferences until it changes one. */
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = Object.freeze({
  opens_soon: true,
  almost_full: true,
  last_hour: true,
  funded: true,
  claims_open: true,
  unlocks: true,
  people_you_follow: true,
  call_moves: true,
});

export const SOCIAL_SETTINGS_ROUTE = "PUT /api/social/me/settings";
export const SOCIAL_SETTINGS_READ_ROUTE = "GET /api/social/me/settings";
export const SOCIAL_SETTINGS_PATH = "/api/social/me/settings";

export const socialExplorerSchema = z.enum(SOCIAL_EXPLORERS);

export function isSocialExplorer(value: unknown): value is SocialExplorer {
  return socialExplorerSchema.safeParse(value).success;
}

const notificationPreferencesSchema = z.strictObject(Object.fromEntries(
  NOTIFICATION_PREFERENCE_KEYS.map((key) => [key, z.boolean()]),
) as Record<NotificationPreferenceKey, z.ZodBoolean>);

const notificationChangesSchema = notificationPreferencesSchema.partial();

export const socialSettingsRequestSchema = z.strictObject({
  private: z.boolean().optional(),
  commit_too_coin_type: z.xor([z.null(), financialCoinTypeSchema]).optional(),
  public_portfolio: z.boolean().optional(),
  explorer: socialExplorerSchema.optional(),
  sound: z.boolean().optional(),
  blast_mode_confirm_actions: z.boolean().optional(),
  notifications: notificationChangesSchema.optional(),
}).meta({
  title: "Social settings update",
  description: "PUT /api/social/me/settings body. Closed; send only the fields that changed. commit_too_coin_type null means each sale's own quote coin; private or public_portfolio before onboarding is 409 onboarding_required; sound is a choice, so only a boolean (never null) is accepted.",
});

export type SocialSettingsRequest = Readonly<z.infer<typeof socialSettingsRequestSchema>>;

export const socialSettingsResponseSchema = z.strictObject({
  privacy: z.enum(SOCIAL_PRIVACY),
  sharing_since_ms: z.xor([
    z.null(),
    z.number().nonnegative().refine(Number.isInteger).meta({ type: "integer" }),
  ]),
  commit_too_coin_type: z.xor([z.null(), financialCoinTypeSchema]),
  public_portfolio: z.boolean(),
  explorer: socialExplorerSchema,
  sound: z.xor([z.null(), z.boolean()]),
  blast_mode_confirm_actions: z.boolean(),
  notifications: notificationPreferencesSchema,
}).meta({
  title: "Social settings of the caller",
  description: "GET and PUT /api/social/me/settings 200: every stored setting (privacy, sharing start, hold pay coin (null: the sale's own coin), public portfolio, explorer, the Feel layer's sound switch (null until the account chooses), the seven notification switches).",
});

export type SocialSettingsResponse = Readonly<z.infer<typeof socialSettingsResponseSchema>>;
