
import { primaryPool } from "@blast/core/modules/database/pool.ts";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { sharedSocialRouteKit } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { createSocialWorkspaceRoute } from "./route.ts";

export function socialWorkspaceRoute(): ReturnType<typeof createSocialWorkspaceRoute> {
  return processSingleton("social.workspace-route", () => createSocialWorkspaceRoute({
    kit: sharedSocialRouteKit(),
    database: () => autocommitReader(primaryPool(), "social", { label: "social.workspace_read" }),
  }));
}
