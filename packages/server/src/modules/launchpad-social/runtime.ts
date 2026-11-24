import { boundedFetch } from "@blast/server/lib/bounded-fetch.ts";
import { trackRequestWork } from "@blast/server/lib/request-work.ts";
import { readHoldersSnapshot } from "@blast/core/modules/launchpad-contract/holders.ts";
import { expectedDeployment } from "@blast/core/modules/launchpad-contract/provenance.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { defaultMarketDataDependencies } from "@blast/core/modules/read-routing/blast-infra.ts";
import { databaseFor } from "@blast/core/modules/read-routing/databases.ts";

import { snapshotHolderProof } from "@blast/server/modules/launchpad-social/holder-proof.ts";
import { SOCIAL_LIMITS } from "@blast/core/modules/launchpad-social/limits.ts";
import type { PostMutationDependencies } from "@blast/server/modules/launchpad-social/mutation.ts";
import { checkLaunch } from "@blast/server/modules/launchpad-social/repository.ts";

/**
 * The production wiring of the post write: the deployment this app serves
 * (`BLAST_NETWORK`, `BLAST_DEPLOYMENT_FINGERPRINT`) and the holder proof over
 * blast-infra's holder snapshot (`BLAST_INFRA_ORIGIN`, with its key): at most
 * `holderProofPages` pages of 100 holders (the top 1,000) within one
 * `holderProofDeadlineMs` deadline (`SOCIAL_LIMITS`). The coin of a launch
 * comes from the canonical launch views on the primary. Without blast-infra
 * configured every disclosed wallet is `unavailable`.
 */
export function postMutationDependencies(): PostMutationDependencies {
  const primary = autocommitReader(
    databaseFor("consistent-read"),
    "launchpad-social",
    { label: "launchpad.holder_proof" },
  );
  return {
    expected: expectedDeployment(),
    limits: SOCIAL_LIMITS,
    holderProof: snapshotHolderProof({
      coinTypeOf: async (launchId) => {
        const check = await checkLaunch(primary, launchId);
        return check.kind === "canonical" ? check.launch.coinType : null;
      },
      // Async, so an unconfigured blast-infra rejects the page read as before.
      readPage: async (coinType, launchId, cursor) => {
        const dependencies = defaultMarketDataDependencies();
        return readHoldersSnapshot(
          coinType,
          launchId,
          { limit: "100", cursor },
          {
            ...dependencies,
            fetch: boundedFetch(3_000, dependencies.fetch),
          },
        );
      },
      trackWork: trackRequestWork,
      maxPages: SOCIAL_LIMITS.holderProofPages,
      deadlineMs: SOCIAL_LIMITS.holderProofDeadlineMs,
    }),
  };
}
