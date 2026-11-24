// Cetus CLMM `config::GlobalConfig`, read for the tick spacings Cetus registers
// and the fee rate it fixes for each. The SDK has no reader for Cetus's
// configuration, so this decodes the object's leading fields.

import { bcs } from "@mysten/sui/bcs";

/**
 * The leading fields of Cetus CLMM `config::GlobalConfig`: `id`,
 * `protocol_fee_rate`, and `fee_tiers: VecMap<u32, FeeTier>`. Later fields
 * (the ACL and the package version) are not read. Checked against Cetus's
 * mainnet object as contracts 442116a snapshots it.
 */
export const cetusGlobalConfigPrefixBcs = bcs.struct("GlobalConfig", {
  id: bcs.Address,
  protocol_fee_rate: bcs.u64(),
  fee_tiers: bcs.struct("VecMap", {
    contents: bcs.vector(
      bcs.struct("Entry", { key: bcs.u32(), value: bcs.struct("FeeTier", { tick_spacing: bcs.u32(), fee_rate: bcs.u64() }) }),
    ),
  }),
});

/** The fee rate Cetus fixes for each tick spacing it registers, in millionths, keyed by the spacing. */
export type CetusFees = Readonly<Record<string, string>>;

export function decodeCetusFees(content: Uint8Array): CetusFees {
  const parsed = cetusGlobalConfigPrefixBcs.parse(content);
  return Object.fromEntries(parsed.fee_tiers.contents.map((entry) => [String(entry.value.tick_spacing), String(entry.value.fee_rate)]));
}
