
import { primaryPool } from "@blast/core/modules/database/pool.ts";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { privyGateway } from "@blast/server/config/privy-gateway.ts";
import { findBlockedTerm } from "@blast/core/modules/social/config/reader.ts";
import { sharedSocialRouteKit, socialAccounts } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { createSocialAccountCreationRoutes } from "@blast/server/modules/social/accounts/creation-routes.ts";
import { createSocialMeRoute } from "@blast/server/modules/social/accounts/me-route.ts";
import { createSocialSettingsRoute } from "@blast/server/modules/social/accounts/settings-route.ts";
import { createSocialXHandleRoute } from "@blast/server/modules/social/accounts/x-handle-route.ts";

export function socialXHandleRoute(): ReturnType<typeof createSocialXHandleRoute> {
  return processSingleton("social.x-handle-route", () =>
    createSocialXHandleRoute({ kit: sharedSocialRouteKit(), primary: primaryPool, privyUsers: privyGateway }));
}

/**
 * The process's `GET /api/social/me` handler: the shared social kit and the
 * primary pool. Built on first use; the pool on the first query, so a missing
 * `DATABASE_URL` fails that request as `service_unavailable`.
 */
export function socialMeRoute(): ReturnType<typeof createSocialMeRoute> {
  return processSingleton("social.me-route", () =>
    createSocialMeRoute({ kit: sharedSocialRouteKit(), accounts: socialAccounts() }));
}

/** The process's `GET` and `PUT /api/social/me/settings` handlers over the shared social kit (primary pool). */
export function socialSettingsRoute(): ReturnType<typeof createSocialSettingsRoute> {
  return processSingleton("social.settings-route", () =>
    createSocialSettingsRoute({
      kit: sharedSocialRouteKit(),
      database: () => autocommitReader(primaryPool(), "social", { label: "social.settings" }),
    }));
}

/**
 * The process's account creation handlers (`POST /api/social/accounts`, `GET
 * /api/social/callsigns/{callsign}`) over the shared social kit, Privy's
 * users API from the environment and the cached blocked terms.
 */
export function socialAccountCreationRoutes(): ReturnType<typeof createSocialAccountCreationRoutes> {
  return processSingleton("social.account-creation-routes", () =>
    createSocialAccountCreationRoutes({
      kit: sharedSocialRouteKit(),
      accounts: socialAccounts(),
      privyUsers: { getUser: (did) => privyGateway().getUser(did) },
      findBlockedTerm,
    }));
}
