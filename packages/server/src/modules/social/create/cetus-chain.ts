import { optionalSource } from "../optional-source.ts";
import { settledAll } from "@blast/server/lib/settled-all.ts";
import { bcs } from "@mysten/sui/bcs";
import { ObjectError, type ClientWithCoreApi } from "@mysten/sui/client";
import { normalizeStructTag, normalizeSuiObjectId } from "@mysten/sui/utils";

import { cetusGlobalConfigPrefixBcs } from "@blast/core/lib/launchpad/cetus-global-config.ts";
import type { PresaleRuntimeIdentity } from "@blast/core/modules/presale/deployment/contracts.ts";
import { CREATE_QUOTES } from "@blast/core/modules/social/contracts/create.ts";
import type { CreateCetusTiers } from "@blast/core/modules/social/create/cetus-options.ts";

const PERMISSION_MANAGER_TYPE = "0x157468379cfe5616c063ae39a889dd184ad48350d3e08f8d9b4ade22b8e3fb61::factory::PermissionPairManager";
const CETUS_PACKAGE = "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb";

// Leading fields of Cetus's PermissionPairManager; later table fields are unused.
const managerBcs = bcs.struct("PermissionPairManager", {
  id: bcs.Address,
  allowed_pair_config: bcs.struct("Table", { id: bcs.Address, size: bcs.u64() }),
});
const spacingsBcs = bcs.struct("VecSet", { contents: bcs.vector(bcs.u32()) });

/** Read the deployed venue's registered fees AND its per-quote reservation permissions. */
export function readCreateCetusTiers(client: ClientWithCoreApi, identity: PresaleRuntimeIdentity): Promise<CreateCetusTiers | null> {
  return optionalSource("cetus_tiers", () => readCetusTiers(client, identity), null);
}

async function readCetusTiers(client: ClientWithCoreApi, identity: PresaleRuntimeIdentity): Promise<CreateCetusTiers> {
  const cetus = identity.venues.cetus;
  if (!cetus) return {};
  const signal = AbortSignal.timeout(5_000);
  const [{ object: config }, { object: manager }] = await settledAll([
    client.core.getObject({ objectId: cetus.globalConfig.objectId, include: { content: true }, signal }),
    client.core.getDynamicObjectField({ parentId: cetus.pools.objectId, name: { type: "0x1::string::String", bcs: bcs.string().serialize("permission_pair_manager").toBytes() }, include: { content: true }, signal }),
  ]);
  if (normalizeSuiObjectId(config.objectId) !== cetus.globalConfig.objectId || normalizeStructTag(config.type) !== `${CETUS_PACKAGE}::config::GlobalConfig` || config.owner.$kind !== "Shared" || config.owner.Shared.initialSharedVersion !== cetus.globalConfig.initialSharedVersion || normalizeStructTag(manager.type) !== PERMISSION_MANAGER_TYPE) {
    throw new Error("The deployment's Cetus configuration has an unexpected identity.");
  }
  const parsedConfig = cetusGlobalConfigPrefixBcs.parse(config.content);
  const parsedManager = managerBcs.parse(manager.content);
  if (normalizeSuiObjectId(parsedConfig.id) !== cetus.globalConfig.objectId || normalizeSuiObjectId(parsedManager.id) !== normalizeSuiObjectId(manager.objectId)) {
    throw new Error("The deployment's Cetus configuration has an unexpected UID.");
  }
  const fees = parsedConfig.fee_tiers.contents;
  const table = parsedManager.allowed_pair_config.id;
  const entries = await settledAll(CREATE_QUOTES.map(async ({ quote_type }) => {
    let allowed: number[];
    try {
      const { dynamicField } = await client.core.getDynamicField({
        parentId: table,
        name: { type: "0x1::type_name::TypeName", bcs: bcs.string().serialize(quote_type.slice(2)).toBytes() },
        signal,
      });
      if (normalizeStructTag(dynamicField.value.type) !== normalizeStructTag("0x2::vec_set::VecSet<u32>")) throw new Error("Unexpected Cetus allowed-pair value type.");
      allowed = spacingsBcs.parse(dynamicField.value.bcs).contents;
    } catch (error) {
      if (!(error instanceof ObjectError) || error.reason !== "notFound") throw error;
      allowed = [];
    }
    const allowedSpacings = new Set(allowed);
    const tiers = fees.filter(({ key, value }) => key === value.tick_spacing && allowedSpacings.has(key))
      .map(({ value }) => [value.tick_spacing, Number(value.fee_rate)] as const);
    return [quote_type, tiers] as const;
  }));
  return Object.fromEntries(entries);
}
