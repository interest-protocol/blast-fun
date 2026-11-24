
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { databaseFor } from "@blast/core/modules/read-routing/databases.ts";
import { presaleRouteKit } from "@blast/server/modules/presale/route-kit/runtime.ts";
import { PostgresAccountSettingsStore } from "@blast/server/modules/presale/settings/repository.ts";
import { createAccountSettingsRoutes } from "@blast/server/modules/presale/settings/routes.ts";

/**
 * The process's `GET|PUT /api/account/settings` handlers: the presale kit,
 * the primary pool and the defaults parsed at boot (`presaleSettingsDefaults`).
 * Built on first use, and the pool on the store's first call, so a missing
 * `DATABASE_URL` fails that request as `service_unavailable`, never the import
 * or the handler's construction.
 */
export function presaleAccountSettingsRoutes(): ReturnType<typeof createAccountSettingsRoutes> {
  return processSingleton("presale.account-settings-routes", () =>
    createAccountSettingsRoutes({
      kit: presaleRouteKit(),
      store: new PostgresAccountSettingsStore(() => databaseFor("write")),
      defaults: runtimeConfig().presaleSettingsDefaults,
    }));
}
