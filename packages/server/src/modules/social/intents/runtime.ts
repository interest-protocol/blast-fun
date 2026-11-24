import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { blastWalletOf } from "@blast/server/modules/social/coins/runtime.ts";
import { verifyDigestProvenance } from "@blast/server/modules/social/transactions/digest-provenance.ts";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { findBlockedTerm, getSocialConfig } from "@blast/core/modules/social/config/reader.ts";
import { sharedSocialRouteKit, socialMainnetClient } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { createSocialIntentRoutes } from "@blast/server/modules/social/intents/route.ts";

/** The intents route over the shared social kit, written on the primary. */
export function socialIntentRoutes(): ReturnType<typeof createSocialIntentRoutes> {
  return processSingleton("social.intent-routes", () =>
    createSocialIntentRoutes({
      kit: sharedSocialRouteKit(),
      async provenance(caller, digest, transactionBytes, signal) {
        const sender = await blastWalletOf(caller);
        if (sender === null) throw new SocialRouteError("blast_wallet_missing");
        await verifyDigestProvenance({ digest, sender, transactionBytes }, async () => {
          const client = socialMainnetClient("social.intent-provenance");
          const result = await client.core.getTransaction({ digest, include: { transaction: true }, signal });
          const transaction = result.Transaction ?? result.FailedTransaction;
          return transaction?.digest === digest ? transaction.transaction?.sender ?? null : null;
        });
      },
      config: getSocialConfig,
      findBlockedTerm,
    }));
}
