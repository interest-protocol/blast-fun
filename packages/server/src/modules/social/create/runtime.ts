import { readCreateQuotePrice, readSuiQuotePrice } from "./quote-price.ts";
import { prepareWalletCoinPublication, readCoinPublication } from "./publish-approval.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { optionalSource } from "../optional-source.ts";
import { readCreationPolicy } from "./creation-policy.ts";
import { primaryPool, replicaPool } from "@blast/core/modules/database/pool.ts";
import { PRESALE_PAUSE_BITS } from "@interest-protocol/blast-sdk/presale";
import { settledAll } from "@blast/server/lib/settled-all.ts";
import { boundedFetch } from "@blast/server/lib/bounded-fetch.ts";
import { trackRequestWork } from "@blast/server/lib/request-work.ts";
import { mainnetIdentity } from "@blast/core/modules/presale/deployment/mainnet-identity.ts";

import { SuiGrpcClient } from "@mysten/sui/grpc";

import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { launchAssetStore } from "@blast/server/modules/launch-assets/store.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { findOwnedAllowlistCapRange } from "@blast/server/modules/presale/allowlists/repository.ts";
import { presaleNodeUrl } from "@blast/core/modules/presale/deployment/node.ts";
import { presaleDeploymentGate, presaleSigningIdentity } from "@blast/server/modules/presale/deployment/runtime.ts";
import { databaseFor } from "@blast/core/modules/read-routing/databases.ts";
import type { CreateFeePolicy } from "@blast/core/modules/social/contracts/create.ts";
import { findBlockedTerm } from "@blast/core/modules/social/config/reader.ts";
import { sharedSocialRouteKit, socialAccounts } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { saleEditor } from "@blast/server/modules/social/sales/runtime.ts";
import { feePolicySource } from "@blast/server/modules/social/create/chain.ts";
import { sponsorService } from "@blast/server/modules/sponsor/runtime.ts";
import { presaleCoinTemplate } from "@blast/server/modules/social/create/coin-template.ts";
import { allowlistCapRange, createSocialCreateRoutes, offeredQuotes, type CreationPolicyReader, type SocialCreateRoutes } from "@blast/server/modules/social/create/route.ts";

import { readBluefinCreateOptions } from "@blast/server/modules/social/create/bluefin-chain.ts";
import { readCreateCetusTiers } from "@blast/server/modules/social/create/cetus-chain.ts";

export async function createQuoteOptions() {
  const identity = mainnetIdentity(presaleDeploymentGate().state);
  const [suiPrice, policy, cetusTiers, bluefinOptions] = await settledAll([
    readSuiQuotePrice(() => autocommitReader(replicaPool(), "social", { label: "social.create_quote_price" })),
    identity ? creationPolicy(identity) : Promise.resolve(undefined),
    createCetusTiers(),
    createBluefinOptions(),
  ]);
  return { cetusTiers, bluefinOptions, quotes: offeredQuotes(suiPrice, policy === undefined ? undefined : policy?.quotes ?? null), suiPrice, policyUnavailable: policy === null };
}

export function createBluefinOptions() {
  return optionalSource("bluefin_options", async () => {
    const identity = mainnetIdentity(presaleDeploymentGate().state);
    return identity ? readBluefinCreateOptions(createNode(), identity) : { status: "unavailable" } as const;
  }, { status: "unavailable" } as const);
}

/** A failed permission read disables Cetus until a fresh read succeeds. */
export function createCetusTiers() {
  return optionalSource("cetus_tiers", async () => {
    const identity = mainnetIdentity(presaleDeploymentGate().state);
    const client = createNode();
    return identity && client ? readCreateCetusTiers(client, identity) : null;
  }, null);
}

const creationPolicy: CreationPolicyReader = (identity) => readCreationPolicy(createNode, identity);

/** The mainnet presale node as a Core API client (one per process), or null before the deploy; Launch builds and reads on it too. */
export function createNode(): SuiGrpcClient | null {
  return processSingleton("social.create-node", () => {
    const state = presaleDeploymentGate().state;
    const baseUrl = presaleNodeUrl(state, runtimeConfig().suiNodeUrl);
    return { client: baseUrl && mainnetIdentity(state) ? new SuiGrpcClient({ network: "mainnet", baseUrl, format: "text", fetch: boundedFetch(8_000) }) : null };
  }).client;
}

/** Blast's rates for the process: the deployed `FeePolicy` once mainnet is live, else `SOCIAL_CREATE_FEE_POLICY` or the defaults. */
export function createFeePolicy(): Promise<CreateFeePolicy> {
  return processSingleton("social.create-fee-policy", () => ({
    read: feePolicySource({ state: presaleDeploymentGate().state, client: createNode, configured: runtimeConfig().social.createFeePolicy, trackWork: trackRequestWork }),
  })).read();
}

/**
 * The production Create routes over the shared social kit: drafts on the
 * primary, allowlists read from the presale module's own tables, logos in
 * the launch-asset Blob store (`LAUNCH_ASSET_BLOB_READ_WRITE_TOKEN`; without
 * it uploads answer `logo_upload_unavailable`), and the presale deployment
 * gate and standalone SDK coin template.
 */
export function socialCreateRoutes(): SocialCreateRoutes {
  return processSingleton("social.create-routes", () => {
    const gate = presaleDeploymentGate();
    const accounts = socialAccounts();
    const config = runtimeConfig();
    return createSocialCreateRoutes({
      kit: sharedSocialRouteKit(),
      feePolicy: createFeePolicy,
      async sponsorCreation({ transaction, ...request }) {
        const client = createNode();
        if (!client) throw new Error("The creation node is not configured.");
        const kindBytes = await transaction.build({ client, onlyTransactionKind: true });
        const sponsored = await sponsorService().sponsor({ ...request, kindBytes, intent: "create", presaleId: null });
        return { reservation_id: sponsored.reservation_id, transaction_bytes: sponsored.transaction_bytes };
      },
      async allowlist(id, ownerDid) {
        const found = await findOwnedAllowlistCapRange(databaseFor("write"), id, { kind: "account", id: ownerDid });
        if (!found) return null;
        // R3-42: whole coins of the list's own quote, to the cent (USDC's 6 decimals, SUI's 9).
        return { allowlist_id: id, ...allowlistCapRange(found) };
      },
      logoStore: () => launchAssetStore(config.launchAssetBlobToken),
      deployment: () => gate.state,
      // R3-42: SUI's price row for the quote picker, public chain data on the replica.
      quotePrice: () => readSuiQuotePrice(() => autocommitReader(replicaPool(), "social", { label: "social.create_quote_price" })),
      raiseQuotePrice: (quoteType) => readCreateQuotePrice(() => autocommitReader(replicaPool(), "social", { label: "social.create_raise_quote_price" }), quoteType),
      coinPublication: (coin, creator, identity, signal) => {
        const client = createNode();
        if (!client) throw new SocialRouteError("service_unavailable");
        return readCoinPublication(client, coin, creator, identity.presale.core.originalPackageId, signal);
      },
      prepareWalletPublication(transaction, signal) {
        const client = createNode();
        if (!client) throw new SocialRouteError("service_unavailable");
        return prepareWalletCoinPublication(client, transaction, signal);
      },
      authorize: (venue, signal) => presaleSigningIdentity(gate, { venue, signal, presalePauseBit: PRESALE_PAUSE_BITS.Create }),
      creationPolicy,
      cetusTiers: createCetusTiers,
      bluefinOptions: createBluefinOptions,
      template: presaleCoinTemplate,
      wallets: async (accountId) => (await accounts.wallets(accountId)).map((wallet) => wallet.address),
      draftLimit: config.social.createDraftLimit,
      // R3-25: covers in the same public store (`cover_upload_unavailable` without its token), the sale's cap holder from mainnet.
      coverStore: () => launchAssetStore(config.launchAssetBlobToken),
      editor: saleEditor(),
      findBlockedTerm,
      database: () => autocommitReader(primaryPool(), "social", { label: "social.create" }),
    });
  });
}
