import { BLAST_DEPLOYMENTS, deploymentFingerprint, launchpadDeployment, type BlastDeployment } from "@interest-protocol/blast-sdk/deployments";
import { decodeLaunchConfigObject, decodeRuntimeConfigObject } from "@interest-protocol/blast-sdk/launchpad";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { normalizeStructTag } from "@mysten/sui/utils";

import { CREATE_QUOTES } from "@blast/core/modules/social/contracts/create.ts";
import { expectedDeployment } from "@blast/core/modules/launchpad-contract/provenance.ts";
import type { BluefinCreateOptions } from "@blast/core/modules/social/create/bluefin-options.ts";
import type { CreateCetusTiers } from "@blast/core/modules/social/create/cetus-options.ts";
import type { LaunchRules } from "@blast/core/modules/social/launch/model.ts";

/** The released mainnet deployment launches are created on, or null before one exists. */
export function launchDeployment(): BlastDeployment | null {
  const deployment = BLAST_DEPLOYMENTS.mainnet;
  if (!deployment) return null;
  try {
    const expected = expectedDeployment();
    return expected?.network === deployment.network && expected.deployment === deploymentFingerprint(deployment) ? deployment : null;
  } catch {
    return null;
  }
}

async function sharedContent(client: ClientWithCoreApi, objectId: string) {
  const { objects } = await client.core.getObjects({ objectIds: [objectId], include: { content: true } });
  const object = objects[0];
  if (!object || object instanceof Error || object.owner.$kind !== "Shared") throw new Error("A launch configuration object could not be read.");
  return { objectId: object.objectId, initialSharedVersion: object.owner.Shared.initialSharedVersion, type: object.type, content: object.content };
}

export type LaunchRulesSources = Readonly<{
  client: ClientWithCoreApi;
  deployment: BlastDeployment;
  cetusTiers: () => Promise<CreateCetusTiers | null>;
  bluefinOptions: () => Promise<BluefinCreateOptions>;
}>;

/**
 * What the deployed launchpad fixes for a new launch, read from the chain:
 * `LaunchConfig` (decimals, trade fees, Blast's allocation, creation fee,
 * admitted quotes and protocol LP fees), `RuntimeConfig` (Blast's share
 * of curve fees), and the live venue tiers. Only supported quotes are offered.
 */
export async function readLaunchRules(sources: LaunchRulesSources): Promise<LaunchRules> {
  const launchpad = launchpadDeployment(sources.deployment);
  const [configObject, runtimeObject, cetusTiers, bluefinOptions] = await Promise.all([
    sharedContent(sources.client, launchpad.launchConfig.objectId),
    sharedContent(sources.client, launchpad.runtimeConfig.objectId),
    sources.cetusTiers(),
    sources.bluefinOptions(),
  ]);
  const config = decodeLaunchConfigObject(configObject, launchpad.originalPackageId);
  const runtime = decodeRuntimeConfigObject(runtimeObject, launchpad.originalPackageId);
  const admitted = new Set(config.quotes.map(normalizeStructTag));
  return {
    meme_decimals: config.memeDecimals.map(Number),
    quote_fee_bps: Number(config.quoteFeeBps),
    meme_fee_bps: Number(config.memeFeeBps),
    protocol_meme_bps: Number(config.protocolAllocation.memeBps),
    protocol_quote_bps: Number(config.protocolAllocation.quoteBps),
    creation_fee: config.creationFee.toString(),
    protocol_fee_share_bps: Number(runtime.protocolFeeShareBps),
    pool_fee_meme_bps: Number(config.protocolLpFees.memeBps),
    pool_fee_quote_bps: Number(config.protocolLpFees.quoteBps),
    quotes: CREATE_QUOTES.map((quote) => quote.quote_type).filter((quote) => admitted.has(normalizeStructTag(quote))),
    cetus_tiers: cetusTiers,
    bluefin_options: bluefinOptions,
  };
}
