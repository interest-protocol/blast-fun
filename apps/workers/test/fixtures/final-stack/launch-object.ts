import { launchBcs, type LaunchObject } from "@interest-protocol/blast-launchpad-sdk";
import { normalizeStructTag, normalizeSuiObjectId } from "@mysten/sui/utils";
import { NON_PRODUCTION_MANIFEST } from "./non-production-deployment.ts";

type Lifecycle = "opening_round" | "live" | "migration_ready" | "migrated";
export function launchObjectFixture(lifecycle: Lifecycle, overrides: { launchId?: string; memeType?: string; launchpadPackage?: string; migrationWitness?: string; poolTickSpacing?: number } = {}): LaunchObject {
  const objectId = normalizeSuiObjectId(overrides.launchId ?? "0xa1");
  const packageId = overrides.launchpadPackage ?? NON_PRODUCTION_MANIFEST.packages.launchpad.originalPackageId;
  const zero = 0n;
  const delayed = { parent: objectId, key: null, delay_ms: 172800000n, pending: null };
  return {
    objectId, initialSharedVersion: "5", mutable: true,
    type: `${packageId}::launch::Launch<${overrides.memeType ?? "0xa::meme::MEME"}, 0x2::sui::SUI>`,
    content: launchBcs.serialize({
      id: { id: { bytes: objectId } }, lifecycle: { [{ opening_round: "OpeningRound", live: "Live", migration_ready: "MigrationReady", migrated: "Migrated" }[lifecycle]]: true } as never,
      public_start_ms: 1790200000000n, opening_round_ms: 3600000n,
      opening_round_bids: 0n, opening_round_quote: zero, opening_round_meme: zero,
      sell_burn_bps: 0n, virtual_quote: 30000000000n, graduation_target: 100000000000n, quote_fee_bps: 100n, meme_fee_bps: 0n,
      venue: normalizeStructTag(overrides.migrationWitness ?? `${NON_PRODUCTION_MANIFEST.packages.migrators.originalPackageId}::cetus::Witness`),
      lp_fee_split: { routes: [{ destination: { kind: "Owner" }, bps: 10000n }] },
      atomic_supply: 1000000000000000n, meme_reserve: 800000000000000n, real_quote_reserve: zero, pending_burn: zero,
      allocation_plan: { curveMemeBps: 8000n, lpMemeBps: 1900n, lpQuoteBps: 9800n, protocolMemeBps: 100n, protocolQuoteBps: 200n, recipients: [] },
      allocated_meme: zero,
      protocol_fees: { packageWitness: `${packageId}::blast_fun::PackageWitness`, origin: objectId, partnerId: null, meme: 0n, quote: 0n, sui: 0n },
      creator_meme_fees: zero, creator_quote_fees: zero,
      metadata_cap: { id: { id: { bytes: normalizeSuiObjectId("0x4d") } } },
      curve_fee_cap_reassignment: delayed, creator_metadata_cap_reassignment: delayed,
      creator: null, curve_fee_cap_id: null, creator_metadata_cap_id: null, partner_id: null,
    }).toBytes(),
  };
}
