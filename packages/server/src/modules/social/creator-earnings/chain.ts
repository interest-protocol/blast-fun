import {
  createPresaleCreatorClient,
  getPresale,
  PresaleTransactions,
  type PresaleCreatorClient,
  type PresaleCreatorTransaction,
} from "@interest-protocol/blast-sdk/presale";
import { getVault } from "@interest-protocol/blast-sdk/vault";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { Inputs } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import type { PresaleRuntimeIdentity } from "@blast/core/modules/presale/deployment/contracts.ts";
import type { CreatorActionKind } from "@blast/core/modules/social/contracts/creator-earnings.ts";

export type CreatorTransaction = PresaleCreatorTransaction & Readonly<{
  vault: Awaited<ReturnType<typeof getVault>>;
}>;

export type CreatorChain = Omit<PresaleCreatorClient, "transaction"> & Readonly<{
  transaction(vaultId: string, sender: string, kind: CreatorActionKind, signal?: AbortSignal): Promise<CreatorTransaction | null>;
}>;

export function createCreatorChain(client: ClientWithCoreApi, identity: PresaleRuntimeIdentity): CreatorChain {
  const { presale } = identity;
  const { cetus, bluefin } = identity.venues;
  const chain = createPresaleCreatorClient(client, {
    presale,
    venues: {
      ...(cetus ? { cetus: { config: cetus.globalConfig, burnManager: cetus.burnManager } } : {}),
      ...(bluefin ? { bluefin: { config: bluefin.globalConfig } } : {}),
    },
  });
  const transactions = new PresaleTransactions(presale);
  const witness = normalizeStructTag(`${presale.originalPackageId}::blast_presale_package::PackageWitness`);
  const capType = normalizeStructTag(`${presale.originalPackageId}::blast_presale::PresaleCap`);

  return {
    ...chain,
    async transaction(vaultId, sender, kind, signal) {
      const vault = await getVault(client, vaultId, presale.vault);
      if (normalizeStructTag(vault.terms.packageWitness) !== witness) return null;
      if (kind === "collect_fees") {
        const collection = await chain.transaction(vaultId, sender, kind, signal);
        return collection && { ...collection, vault };
      }
      if (vault.ownerMeme === 0n && vault.ownerQuote === 0n) return null;

      const sale = await getPresale(client, vault.terms.origin, presale.originalPackageId);
      if (sale.saleTokenType !== vault.memeType || sale.quoteType !== vault.quoteType) return null;
      const { objects: [cap] } = await client.core.getObjects({
        objectIds: [sale.presaleCapId],
        signal,
      });
      if (!cap || cap instanceof Error || normalizeStructTag(cap.type) !== capType ||
        cap.owner.$kind !== "AddressOwner" || normalizeSuiAddress(cap.owner.AddressOwner) !== normalizeSuiAddress(sender)) return null;

      const transaction = transactions.claimOwnerBalances({
        saleTokenType: sale.saleTokenType,
        quoteType: sale.quoteType,
        presale: sale,
        presaleCap: Inputs.ObjectRef(cap),
        vault,
        recipient: sender,
      });
      transaction.setSender(sender);
      return {
        vault,
        vaultId: vault.objectId,
        presaleId: sale.objectId,
        transaction,
        kindBytes: await transaction.build({ onlyTransactionKind: true }),
      };
    },
  };
}
