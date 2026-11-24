import { primaryPool } from "@blast/core/modules/database/pool.ts";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { readCreatorCommitment } from "../creator-claims/commitment.ts";
import { sharedSocialRouteKit, socialAccounts } from "../route-kit/shared-runtime.ts";
import { createMyBondingLaunchesRoute } from "./discovery.ts";

export function myBondingLaunchesRoute() {
  return processSingleton("social.my-bonding-launches", () =>
    createMyBondingLaunchesRoute({
      kit: sharedSocialRouteKit(),
      wallets: async (accountId) =>
        (await socialAccounts().wallets(accountId)).map(
          (wallet) => wallet.address,
        ),
      commitment: (accountId) =>
        readCreatorCommitment(
          autocommitReader(primaryPool(), "social", {
            label: "social.launch_discovery",
          }),
          accountId,
        ),
    }),
  );
}
