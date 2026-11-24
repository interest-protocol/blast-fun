import { presaleAccountSettingsRoutes } from "../modules/presale/settings/runtime.ts";
import { presaleAccountWalletsRoutes } from "../modules/presale/account/runtime.ts";
import type { PrivateHandlers } from "./handler.ts";

/** The unchanged presale kit authorizes the Privy DID and charges each business bucket once. */
export const ACCOUNT_HANDLERS = {
  "account.settings.read": (request, { client }) =>
    presaleAccountSettingsRoutes().GET(request, client),
  "account.settings.write": (request, { client }) =>
    presaleAccountSettingsRoutes().PUT(request, client),
  "account.wallets": (request, { client }) => presaleAccountWalletsRoutes().GET(request, client),
} satisfies PrivateHandlers;
