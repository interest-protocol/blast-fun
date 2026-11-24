// Mainnet reservation from AQzKDUJbWkqDEuASEKv1zmyFF2mffDuCb1tx6xXVYgfh.
import { protocolFeesPaidBcs } from "@interest-protocol/blast-core/protocol-fees";
import { presaleDeployment, type BlastDeployment } from "@interest-protocol/blast-deployments-sdk";
import { aftermathDaoPresaleEventBcs } from "@interest-protocol/blast-presale-sdk/aftermath-dao";
import { presaleEventBcs } from "@interest-protocol/blast-presale-sdk/events";
import type { PresaleState } from "@interest-protocol/blast-presale-sdk/state";
import { PresaleTransactions } from "@interest-protocol/blast-presale-sdk/transactions";
import type { SuiClientTypes } from "@mysten/sui/client";
import { normalizeStructTag, SUI_TYPE_ARG } from "@mysten/sui/utils";

const product = "0x1f44a8e9fab4380228fe9c1bcc27d99b7f6ea76a8e18b5c178ca18cd46fb33c4";
const vendor = "0x58f45e1b3057be882ebd991e67cb81e9543acf123f0013c5011b918413525d1f";
const venue = `${vendor}::blast_aftermath_dao_presale::Venue`;
const lpType = "0x071cf7e89a976f22332c8073522e35ed02cf2e2ff2eaa3e7f81cefd08057f441::af_lp::AF_LP";
const initialSharedVersion = "1100992989";
const registry = { objectId: "0xfcc774493db2c45c79f688f88d28023a3e7d98e4ee9f48bbf5c7990f651577ae", initialSharedVersion: "6808332" };
const target = 60_000_000_000_000n;

export const kares = {
  object: { objectId: "0x2d8a594aa263e02eba9049f7f37be4fe8a7309a2635a05165b2df7a7455f9b7b", initialSharedVersion },
  memeType: "0x8a24551ca06b0688a1127ad0651a9dc89bce3a1899e492228169f083a84c5047::kares::KARES",
  quoteType: normalizeStructTag(SUI_TYPE_ARG),
  poolCreation: { objectId: "0x20bf802c96c0f1eaa59e15d43d34b32aa4c4557232bd15d5ca4f8ce85a3a0437", initialSharedVersion },
} as const;

export function karesReady(sale: PresaleState, reservation: string | null | undefined) {
  return sale.objectId === kares.object.objectId && sale.raiseTarget === target && sale.totalCommitments === target &&
    sale.saleTokenType === kares.memeType && normalizeStructTag(sale.quoteType) === kares.quoteType &&
    normalizeStructTag(sale.venue) === venue && reservation === kares.poolCreation.objectId;
}

export function karesMigration(deployment: BlastDeployment, settle: boolean) {
  const base = presaleDeployment(deployment);
  if (deployment.chainIdentifier !== "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S" || base.packageId !== product) throw new Error("kares-deployment-mismatch");
  const sdk = new PresaleTransactions({ ...base, aftermathDaoPresale: {
    packageId: vendor,
    originalPackageId: vendor,
    adminCapId: "0x4b7d3778a2a12cdf5c3a944bfdd927e301640b2abdb534081bef7dca4b675362",
    aftermath: {
      poolRegistry: registry,
      daoFeeVersion: { objectId: "0xb4bfb0f917f12ad2a772bea9b4f22431f6f5f9653162c3ae6fae5b99b21392b7", initialSharedVersion: "293243902" },
    },
  } });
  const tx = sdk.migrate({
    venue: "aftermathDao", saleTokenType: kares.memeType, quoteType: kares.quoteType,
    presale: kares.object, poolCreation: kares.poolCreation, lpType, settle,
  });
  // Unify the vendor's AMM dependency with v5, which supports the live registry.
  tx.moveCall({
    target: "0x93056cd889839d7186498c5e86d3087cb79dacb08ae0e18b9b2c42ebe06d7be7::pool_registry::protocol_version",
    arguments: [tx.sharedObjectRef({ ...registry, mutable: false })],
  });
  return tx;
}

const blast = "0x818d6d7026632f82367a9ca2413a5bb28aeec2a1b8dedca919ef812577b4d0a2";
const ares = "0x37cf46b499f740e653644bd2f7a8ed97f248e8b3c69d5d12c97d7845a54c0cd8";
const core = "0xd70a8d11582fd1997380bc59bfd56a2f9028ebe11da74514ea3d386258d932fc";
const pair = `${kares.memeType},${kares.quoteType}`;
const recipient = { presale_id: kares.object.objectId, vesting_id: null };
type SimulationEvent = Pick<SuiClientTypes.Event, "eventType" | "bcs">;

// Compare the full event payload so a treasury change, partner, new payout or vesting cannot pass.
const payouts = [
  { type: `${core}::blast_core_events::ProtocolFeesPaid<${pair}>`, bytes: protocolFeesPaidBcs.serialize({
    package_witness: `${product}::blast_presale_package::PackageWitness`, origin: kares.object.objectId, treasury: blast,
    meme_amount: 0n, quote_amount: 1_200_000_000_000n, sui_amount: 0n,
    partner_id: null, partner_meme_amount: 0n, partner_quote_amount: 0n, partner_sui_amount: 0n,
  }).toBytes() },
  { type: `${product}::events::RaiseAllocated<${pair}>`, bytes: presaleEventBcs.RaiseAllocated.serialize({
    ...recipient, recipient: ares, quote: 34_200_000_000_000n,
  }).toBytes() },
  { type: `${product}::events::RaiseAllocated<${pair}>`, bytes: presaleEventBcs.RaiseAllocated.serialize({
    ...recipient, recipient: blast, quote: 600_000_000_000n,
  }).toBytes() },
  { type: `${product}::events::RecipientAllocated<${pair}>`, bytes: presaleEventBcs.RecipientAllocated.serialize({
    ...recipient, recipient: ares, tokens: 440_000_000_000_000_000n,
  }).toBytes() },
];

export function karesPayoutsMatch(events: readonly SimulationEvent[]) {
  const observed = events.filter(e => payouts.some(p => normalizeStructTag(e.eventType) === p.type));
  return observed.length === payouts.length && payouts.every(({ type, bytes }, i) =>
    normalizeStructTag(observed[i]!.eventType) === type && Buffer.from(bytes).equals(observed[i]!.bcs));
}

export function karesPoolSimulated(_cost: bigint, events: readonly SuiClientTypes.Event[]) {
  if (!karesPayoutsMatch(events)) return false;
  const sale = events.find(e => normalizeStructTag(e.eventType) === `${product}::events::PresaleMigrated<${pair}>`);
  const pool = events.find(e => normalizeStructTag(e.eventType) === `${vendor}::blast_aftermath_dao_presale::Migrated<${lpType},${pair}>`);
  if (!sale || !pool) return false;
  const allocation = presaleEventBcs.PresaleMigrated.parse(sale.bcs);
  const creation = aftermathDaoPresaleEventBcs.Migrated.parse(pool.bcs);
  return allocation.presale_id === kares.object.objectId && allocation.venue === venue &&
    allocation.recipient_tokens === 440_000_000_000_000_000n &&
    allocation.liquidity_quote === 24_000_000_000_000n && allocation.liquidity_tokens === 160_000_000_000_000_000n &&
    creation.presale_id === kares.object.objectId && creation.lp > 0n;
}
