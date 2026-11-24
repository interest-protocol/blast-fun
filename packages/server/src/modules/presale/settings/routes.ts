import type { AccountSettings, AccountSettingsResponse } from "@blast/core/modules/presale/contracts/web-api.ts";
import { accountSettingsSchema } from "@blast/core/modules/presale/contracts/account-settings.ts";
import { PresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";
import { readJsonBody, type PresaleRequestContext, type PresaleRouteKit } from "@blast/core/modules/presale/route-kit/route.ts";

/** Each account's saved settings by Privy DID. */
export interface AccountSettingsStore {
  find(did: string): Promise<AccountSettings | null>;
  save(did: string, settings: AccountSettings): Promise<void>;
}

/**
 * The settings of an account with nothing saved: `PRESALE_DEFAULT_EXPLORER`
 * (shipped `suivision`) and `PRESALE_DEFAULT_THEME` (shipped `system`). Parsed
 * once at boot; a value outside its enum stops boot.
 */
export function presaleSettingsDefaults(
  environment: Readonly<Record<string, string | undefined>>,
): AccountSettings {
  const result = accountSettingsSchema.safeParse({
    explorer: environment.PRESALE_DEFAULT_EXPLORER || "suivision",
    theme: environment.PRESALE_DEFAULT_THEME || "system",
  });
  if (!result.success) {
    throw new Error("PRESALE_DEFAULT_EXPLORER and PRESALE_DEFAULT_THEME must name a known explorer and theme.");
  }
  return result.data;
}

/**
 * A `PUT` body: an object with exactly `explorer` and `theme`, each from its
 * enum, else `invalid_settings`.
 */
export function parseAccountSettings(value: unknown): AccountSettings {
  const result = accountSettingsSchema.safeParse(value);
  if (!result.success) {
    throw new PresaleRouteError("invalid_settings");
  }
  return result.data;
}

function did(context: PresaleRequestContext): string {
  // `auth: "account"` admits no request without one.
  return context.account!.did;
}

/** `GET|PUT /api/account/settings` (contract 3.5, CL-8) for signed-in accounts. */
export function createAccountSettingsRoutes(dependencies: Readonly<{
  kit: PresaleRouteKit;
  store: AccountSettingsStore;
  /** What an account with nothing saved gets (`RuntimeConfig.presaleSettingsDefaults`). */
  defaults: AccountSettings;
}>) {
  const { kit, store, defaults } = dependencies;
  return Object.freeze({
    GET: kit.route(
      { name: "GET /api/account/settings", auth: "account", bucket: "presale_settings" },
      async (context) => {
        const saved = await store.find(did(context));
        const body: AccountSettingsResponse = saved
          ? { ...saved, saved: true }
          : { ...defaults, saved: false };
        return context.json(body);
      },
    ),
    PUT: kit.route(
      { name: "PUT /api/account/settings", auth: "account", bucket: "presale_settings" },
      async (context) => {
        const settings = parseAccountSettings(await readJsonBody(context.request));
        await store.save(did(context), settings);
        const body: AccountSettingsResponse = { ...settings, saved: true };
        return context.json(body);
      },
    ),
  });
}
