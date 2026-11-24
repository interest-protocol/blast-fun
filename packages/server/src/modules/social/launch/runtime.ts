import { primaryPool } from "@blast/core/modules/database/pool.ts";
import { deploymentFingerprint, evaluateProtocolAccess, launchpadDeployment, observeDeploymentRuntime } from "@interest-protocol/blast-sdk/deployments";
import { getLaunch, LAUNCHPAD_PAUSE_BITS, readMemePublication } from "@interest-protocol/blast-sdk/launchpad";
import { ObjectError, TransactionError, type ClientWithCoreApi } from "@mysten/sui/client";

import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";

import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { autocommitReader, withTransaction } from "@blast/core/modules/database/transaction.ts";
import { findBlockedTerm } from "@blast/core/modules/social/config/reader.ts";
import type { LaunchPageContext } from "@blast/core/modules/social/contracts/launch.ts";
import type { LaunchRules } from "@blast/core/modules/social/launch/model.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { launchAssetStore } from "@blast/server/modules/launch-assets/store.ts";
import { expireUnsubmittedCreation } from "@blast/server/modules/sponsor/reservations.ts";
import { sponsorService } from "@blast/server/modules/sponsor/runtime.ts";
import { createBluefinOptions, createCetusTiers, createNode } from "@blast/server/modules/social/create/runtime.ts";
import { creatorCommitmentOf, readCreatorCommitment } from "@blast/server/modules/social/creator-claims/commitment.ts";
import { replacedWalletGas } from "@blast/server/modules/social/launch/reconcile.ts";
import { launchMemeTemplate } from "@blast/server/modules/social/launch/meme-template.ts";
import { createSocialLaunchRoutes, type SocialLaunchRoutes } from "@blast/server/modules/social/launch/route.ts";
import { launchDeployment, readLaunchRules } from "@blast/server/modules/social/launch/rules.ts";
import type { LaunchStepPlan } from "@blast/server/modules/social/launch/store.ts";
import { sharedSocialRouteKit, socialAccounts } from "@blast/server/modules/social/route-kit/shared-runtime.ts";

const RULES_TTL_MS = 60_000;

/**
 * The deployed launchpad's rules for the process, read at most once a
 * minute; a failed read keeps the last good one, else fails.
 */
export function launchRules(): Promise<LaunchRules> {
  const cache = processSingleton("social.launch-rules", () => ({ at: 0, rules: null as LaunchRules | null, pending: null as Promise<LaunchRules> | null }));
  if (cache.rules && Date.now() - cache.at < RULES_TTL_MS) return Promise.resolve(cache.rules);
  if (cache.pending) return cache.pending;
  const client = createNode();
  const deployment = launchDeployment();
  if (!client || !deployment) return Promise.reject(new Error("The launchpad is not reachable."));
  cache.pending = readLaunchRules({ client, deployment, cetusTiers: createCetusTiers, bluefinOptions: createBluefinOptions })
    .then((rules) => {
      cache.rules = rules;
      cache.at = Date.now();
      return rules;
    })
    .catch((error: unknown) => {
      if (cache.rules) return cache.rules;
      throw error;
    })
    .finally(() => {
      cache.pending = null;
    });
  return cache.pending;
}

/** What `/launch` renders with before a draft loads: the rules, or why launching is off. */
export async function launchPageContext(): Promise<LaunchPageContext> {
  if (!launchDeployment() || !createNode()) return { rules: null, publish: { available: false, reasons: ["launchpad_not_deployed"] } };
  try {
    const rules = await launchRules();
    if (rules.quotes.length === 0) return { rules, publish: { available: false, reasons: ["quote_not_admitted"] } };
    return { rules, publish: { available: true, reasons: [] } };
  } catch {
    return { rules: null, publish: { available: false, reasons: ["launch_config"] } };
  }
}

async function missingPublicationStatus(client: ClientWithCoreApi, saved: LaunchStepPlan, creator: string, accountKey: string | null): Promise<"failed" | "pending"> {
  const sponsorship = saved.plan.steps[0].sponsorship;
  if (sponsorship && accountKey) {
    const expired = await withTransaction(primaryPool(), (transaction) => expireUnsubmittedCreation(transaction.forModule("presale-sponsor"), { reservationId: sponsorship.reservation_id, privyDid: accountKey, sender: creator }, new Date()), { label: "social.launch_expire" });
    if (expired) return "failed";
  }
  if (!sponsorship && await replacedWalletGas(client, saved)) return "failed";
  return "pending";
}

/**
 * The production Launch routes over the shared social kit: drafts on the
 * primary, logos and covers in the launch-asset Blob store, the released
 * mainnet deployment, and the presale's sponsor service for Blast wallets.
 */
export function socialLaunchRoutes(): SocialLaunchRoutes {
  return processSingleton("social.launch-routes", () => {
    const accounts = socialAccounts();
    const database = () => autocommitReader(primaryPool(), "social", { label: "social.launch" });
    return createSocialLaunchRoutes({
      kit: sharedSocialRouteKit(),
      rules: launchRules,
      deployment: launchDeployment,
      async canPublish(deployment, venue) {
        const client = createNode();
        if (!client) return false;
        const runtime = await observeDeploymentRuntime(client, deployment).catch(() => null);
        if (!runtime) return false;
        const access = evaluateProtocolAccess({ manifest: deployment, mode: "production", runtime });
        return access.signing === "enabled" && access.venues[venue].available && (access.paused.launchpad & LAUNCHPAD_PAUSE_BITS.Create) === 0;
      },
      logoStore: () => launchAssetStore(runtimeConfig().launchAssetBlobToken),
      coverStore: () => launchAssetStore(runtimeConfig().launchAssetBlobToken),
      template: launchMemeTemplate,
      wallets: async (accountId) => (await accounts.wallets(accountId)).map((wallet) => wallet.address),
      async commitment(context, accountId) {
        return (await readCreatorCommitment(database(), accountId))
          ?? context.transaction((social) => creatorCommitmentOf(social, accountId), { label: "social.creator_commitment" });
      },
      async launchMemeType(launchId) {
        const client = createNode();
        const deployment = launchDeployment();
        if (!client || !deployment) throw new Error("The launchpad is not reachable.");
        try {
          return (await getLaunch(client, launchId, launchpadDeployment(deployment).originalPackageId)).memeType;
        } catch (error) {
          if (error instanceof ObjectError && error.reason === "notFound") return null;
          throw error;
        }
      },
      async preparePublication(transaction) {
        const client = createNode();
        if (!client) throw new Error("The creation node is not configured.");
        const bytes = await transaction.build({ client });
        return { transaction: await Transaction.from(bytes).toJSON(), digest: TransactionDataBuilder.getDigestFromBytes(bytes) };
      },
      async publicationStatus(saved, creator, accountKey) {
        const client = createNode();
        if (!client) throw new Error("The creation node is not configured.");
        try {
          const result = await client.core.getTransaction({ digest: saved.digest });
          return result.$kind === "FailedTransaction" ? "failed" : "confirmed";
        } catch (error) {
          if (!(error instanceof TransactionError && error.reason === "notFound")) throw error;
          return missingPublicationStatus(client, saved, creator, accountKey);
        }
      },
      async publicationCoin(publication) {
        const client = createNode();
        const saved = publication.steps.publish_coin;
        if (!client || !saved) throw new Error("The coin publication is unavailable.");
        const result = await client.core.getTransaction({ digest: saved.digest, include: { effects: true, objectTypes: true } });
        if (result.$kind !== "Transaction") throw new Error("The coin publication did not succeed.");
        const deployment = launchDeployment();
        if (!deployment || saved.plan.deployment_fingerprint !== deploymentFingerprint(deployment) ||
          saved.plan.launchpad_original_package_id !== deployment.packages.launchpad.originalPackageId ||
          saved.plan.core_original_package_id !== deployment.packages.core.originalPackageId) {
          throw new Error("The coin publication belongs to another deployment.");
        }
        const coin = readMemePublication(result.Transaction, launchpadDeployment(deployment));
        if (coin.ticket.owner !== publication.creator) throw new Error("The publication did not deliver the launch ticket to the creator.");
        return {
          coin_type: coin.memeType,
          sealed_treasury_cap: { object_id: coin.sealedTreasuryCap.objectId, version: coin.sealedTreasuryCap.version, digest: coin.sealedTreasuryCap.digest },
          ticket: { object_id: coin.ticket.objectId, version: coin.ticket.version, digest: coin.ticket.digest },
          currency: { object_id: coin.pendingCurrency.objectId, version: coin.pendingCurrency.version, digest: coin.pendingCurrency.digest },
        };
      },
      findBlockedTerm,
      async sponsorCreation({ transaction, ...request }) {
        const client = createNode();
        if (!client) throw new Error("The creation node is not configured.");
        const kindBytes = await transaction.build({ client, onlyTransactionKind: true });
        const sponsored = await sponsorService().sponsor({ ...request, kindBytes, intent: "create", presaleId: null });
        return { reservation_id: sponsored.reservation_id, transaction_bytes: sponsored.transaction_bytes };
      },
      database,
    });
  });
}
