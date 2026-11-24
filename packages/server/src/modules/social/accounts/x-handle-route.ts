import type { Pool } from "pg";

import { errorLabel, recordMetric } from "@blast/core/lib/metrics.ts";
import type { PrivyProviderGateway } from "@blast/core/lib/privy-adapter/types.ts";
import { withTransaction } from "@blast/core/modules/database/transaction.ts";
import type { SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { findLinkedXAccount } from "@blast/server/lib/privy-adapter/adapter.ts";

const ROUTE = "POST /api/social/me/x-handle";

/** Refreshes verified X metadata and fills a missing subject without replacing an existing identity. */
export function createSocialXHandleRoute(
  input: Readonly<{
    kit: SocialRouteKit;
    primary: () => Pool;
    privyUsers: () => Pick<PrivyProviderGateway, "getUser">;
  }>,
) {
  return input.kit.route(
    {
      name: ROUTE,
      auth: "account",
      account: "resolve",
      bucket: "social_me_read",
      cache: "private",
    },
    async (context) => {
      if (context.caller?.kind !== "privy" || !context.account)
        return context.json({ updated: false });
      let x;
      try {
        // shortcut: Privy's stored X metadata is authoritative here; use an X lookup if fresh OAuth leaves it stale.
        x = await findLinkedXAccount(input.privyUsers(), context.caller.did);
      } catch (error) {
        recordMetric("social.privy_users", {
          route: ROUTE,
          outcome: "unavailable",
          cause: errorLabel(error),
        });
        return context.json({ updated: false });
      }
      if (!x) return context.json({ updated: false });
      const account = context.account;
      const result = await withTransaction(
        input.primary(),
        async (transaction) => {
          if (account.kind === "member") {
            const updated = await transaction.forModule("profile").write(
              "mission_control_profiles",
              `UPDATE mission_control_profiles SET x_handle = COALESCE($3,x_handle)
             WHERE profile_id = (SELECT profile_id FROM social_accounts WHERE account_id = $1)
               AND x_subject = $2 AND x_handle IS DISTINCT FROM COALESCE($3,x_handle)`,
              [account.account_id, x.xSubject, x.handle],
            );
            if (updated.rowCount)
              await transaction
                .forModule("social")
                .write(
                  "social_accounts",
                  "UPDATE social_accounts SET profile_id = profile_id WHERE account_id = $1",
                  [account.account_id],
                );
            return updated;
          }
          return transaction.forModule("social").write(
            "social_accounts",
            `UPDATE social_accounts SET x_subject = $2, x_handle = COALESCE($3,x_handle)
           WHERE account_id = $1 AND (x_subject IS NULL OR x_subject = $2)
             AND (x_subject IS DISTINCT FROM $2 OR x_handle IS DISTINCT FROM COALESCE($3,x_handle))`,
            [account.account_id, x.xSubject, x.handle],
          );
        },
      );
      return context.json({ updated: result.rowCount === 1 });
    },
  );
}
