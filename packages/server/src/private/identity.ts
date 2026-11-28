import {
  socialAccountCreationRoutes,
  socialMeRoute,
  socialSettingsRoute,
  socialXHandleRoute,
} from "../modules/social/accounts/runtime.ts";
import { socialWalletRoutes } from "../modules/social/wallets/runtime.ts";
import { socialWalletSignInRoutes } from "../modules/social/wallet-sign-in/runtime.ts";
import type { PrivateHandlers } from "./handler.ts";

/** The business owners are lazy, canonical and executed exclusively by Bun routes. */
export const IDENTITY_HANDLERS = {
  "social.me": (request, { client }) => socialMeRoute().GET(request, client),
  "social.accounts.create": (request, { client }) =>
    socialAccountCreationRoutes().create.POST(request, client),
  "social.callsign": (request, { client }) =>
    socialAccountCreationRoutes().callsign.GET(request, client),
  "social.settings.read": (request, { client }) => socialSettingsRoute().GET(request, client),
  "social.settings.write": (request, { client }) => socialSettingsRoute().PUT(request, client),
  "social.x-handle": (request, { client }) => socialXHandleRoute()(request, client),
  "social.wallet.challenge": (request, { client }) =>
    socialWalletRoutes().challenge.POST(request, client),
  "social.wallet.link": (request, { client }) => socialWalletRoutes().link.POST(request, client),
  "social.wallet.unlink": (request, { client }) => socialWalletRoutes().unlink.DELETE(request, client),
  "social.sign-in.challenge": (request, { client }) =>
    socialWalletSignInRoutes().challenge.POST(request, client),
  "social.sign-in.session": (request, { client }) =>
    socialWalletSignInRoutes().session.POST(request, client),
  "social.sign-in.logout": (request, { client }) =>
    socialWalletSignInRoutes().session.DELETE(request, client),
} satisfies PrivateHandlers;
