// Which tick spacings Cetus registers now, and the fee rate it fixes for
// each, read from the deployment's recorded Cetus `config::GlobalConfig`. A
// Cetus launch can be created only at a spacing Cetus registers
// (`cetus::new` calls `config::get_fee_rate`, contracts 442116a
// `sui/migrators/sources/cetus.move`), and its review is honest only while
// that fee rate equals the tier the deployment records.

import type { BlastDeployment } from "@interest-protocol/blast-sdk/deployments";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { normalizeStructTag } from "@mysten/sui/utils";

import { decodeCetusFees, type CetusFees } from "@blast/core/lib/launchpad/cetus-global-config.ts";

/** Reads the recorded Cetus `GlobalConfig` now; throws when the deployment records none or the node reports another object. */
export async function readCetusFees(client: ClientWithCoreApi, deployment: BlastDeployment): Promise<CetusFees> {
  const identity = deployment.sharedObjects.cetus?.config;
  const cetus = deployment.packages.cetusClmm;
  if (!identity || !cetus) throw new Error("This Blast deployment records no Cetus GlobalConfig.");
  const { objects } = await client.core.getObjects({ objectIds: [identity.objectId], include: { content: true } });
  const object = objects[0];
  const expected = normalizeStructTag(`${cetus.originalPackageId}::config::GlobalConfig`);
  if (!object || object instanceof Error || normalizeStructTag(object.type) !== expected || !object.content) {
    throw new Error(`${identity.objectId} is not the recorded Cetus GlobalConfig.`);
  }
  return decodeCetusFees(object.content);
}
