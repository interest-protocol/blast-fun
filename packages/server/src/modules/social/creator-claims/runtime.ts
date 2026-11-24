import { primaryPool } from "@blast/core/modules/database/pool.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { configuredLaunchReadChain } from "@blast/server/modules/launchpad-coin/chain.ts";
import { sponsorService } from "@blast/server/modules/sponsor/runtime.ts";
import { blastWalletOf } from "@blast/server/modules/social/coins/runtime.ts";
import { sharedSocialRouteKit } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { createCreatorCapsChain, type CreatorCapsChain } from "./chain.ts";
import { createCreatorClaimRoutes, type CreatorClaimRoutes } from "./route.ts";

/**
 * The production creator claim routes: the shared social kit, the primary, the released Blast
 * deployment on `BLAST_NETWORK` and its fullnode (claiming is off while none is released, as the
 * coin page's signing is), the signer parsed at boot from `CREATOR_CLAIM_SIGNER_KEY`, the presale
 * sponsor for every caller's wallet, and the Blast wallet resolver the coins sheet uses. The
 * chain is built once.
 */
export function creatorClaimRoutes(): CreatorClaimRoutes {
  return processSingleton("social.creator-claim-routes", () => {
    let reads: Promise<CreatorCapsChain | null> | undefined;
    return createCreatorClaimRoutes({
      kit: sharedSocialRouteKit(),
      database: () => autocommitReader(primaryPool(), "social", { label: "social.creator_claims" }),
      chain() {
        reads ??= configuredLaunchReadChain().then((configured) => configured && createCreatorCapsChain(configured));
        return reads;
      },
      signer: () => runtimeConfig().creatorClaimSigner,
      blastWallet: blastWalletOf,
      sponsor: (request) => sponsorService().sponsor({ ...request, intent: "creator_caps", presaleId: null }),
    });
  });
}
