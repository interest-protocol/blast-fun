import { observeMetric, errorLabel } from "@blast/core/lib/metrics.ts";
import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { normalizeStructTag, normalizeSuiObjectId } from "@mysten/sui/utils";

import type { PresaleRuntimeIdentity } from "@blast/core/modules/presale/deployment/contracts.ts";
import type { BluefinCreateOptions } from "@blast/core/modules/social/create/bluefin-options.ts";

// BluefinSpot's pinned interface (91ce930) defines the same original type across upgrades.
const GLOBAL_CONFIG_TYPE = "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267::config::GlobalConfig";
const globalConfigBcs = bcs.struct("GlobalConfig", {
  id: bcs.Address,
  min_tick: bcs.struct("I32", { bits: bcs.u32() }),
  max_tick: bcs.struct("I32", { bits: bcs.u32() }),
  version: bcs.u64(),
  reward_managers: bcs.vector(bcs.Address),
});

/** Reads the actual full-range bounds used by Bluefin migration; unreadable state stays disabled. */
export async function readBluefinCreateOptions(client: ClientWithCoreApi | null, identity: PresaleRuntimeIdentity): Promise<BluefinCreateOptions> {
  const config = identity.venues.bluefin?.globalConfig;
  if (!client || !config) {
    return { status: "unavailable" };
  }

  try {
    const { object } = await client.core.getObject({ objectId: config.objectId, include: { content: true }, signal: AbortSignal.timeout(3_000) });
    if (normalizeSuiObjectId(object.objectId) !== config.objectId || normalizeStructTag(object.type) !== GLOBAL_CONFIG_TYPE || object.owner.$kind !== "Shared" || object.owner.Shared.initialSharedVersion !== config.initialSharedVersion) {
      throw new Error("Unexpected Bluefin configuration.");
    }

    const parsed = globalConfigBcs.parse(object.content);
    if (normalizeSuiObjectId(parsed.id) !== config.objectId || globalConfigBcs.serialize(parsed).toBytes().length !== object.content.length) {
      throw new Error("Unexpected Bluefin configuration.");
    }

    const minTick = parsed.min_tick.bits | 0;
    const maxTick = parsed.max_tick.bits | 0;
    if (minTick >= maxTick) {
      throw new Error("Unexpected Bluefin configuration.");
    }

    return { status: "ready", min_tick: minTick, max_tick: maxTick };
  } catch (error) {
    observeMetric("social.source", { source: "bluefin_options", outcome: "unavailable", error: errorLabel(error) });
    return { status: "unavailable" };
  }
}
