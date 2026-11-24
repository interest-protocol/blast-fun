import { SUI_COIN_TYPE as quote } from "@blast/core/lib/sui/coin-types.ts";
import {
  launchpadEventBcs,
  launchpadEventSpecs,
  type LaunchpadEventKind,
} from "@interest-protocol/blast-sdk/launchpad";
import { presaleEventBcs, type PresaleEventKind } from "@interest-protocol/blast-sdk/presale";
import { delayedEventBcs } from "@interest-protocol/blast-sdk/admin";
import { vaultDelayedKeys, vaultEventBcs, type VaultEventKind } from "@interest-protocol/blast-sdk/vault";
import { protocolFeesPaidBcs, type ProtocolFeesPaid } from "@interest-protocol/blast-core/protocol-fees";
import type { FeeSplit } from "@interest-protocol/blast-core/fee-split";
import { normalizeStructTag } from "@mysten/sui/utils";
import type { BcsType } from "@mysten/sui/bcs";
import type { NativeEvent } from "./accounting.ts";
import { parseProfile } from "./contracts.ts";
type FixtureEvent = NativeEvent & { bcs: Uint8Array };

export const objectId = (digit: string) => `0x${digit.repeat(64)}`;
export const profile = parseProfile({
  network: "mainnet",
  deployment_fingerprint: "a".repeat(64),
  launchpad_original_package: objectId("1"),
  presale_original_package: objectId("2"),
  vault_original_package: objectId("6"),
  core_original_package: objectId("b"),
  admin_original_package: objectId("c"),
  first_checkpoint: "100",
  excluded_meme_packages: [],
  policy_version: "release-v1",
});
export const meme = normalizeStructTag(`${objectId("3")}::m::Coin`);
export { SUI_COIN_TYPE as quote } from "@blast/core/lib/sui/coin-types.ts";
export const day = "2026-10-20";
export const start = Date.parse(`${day}T00:00:00Z`);
export const end = start + 86_400_000;
const launchId = objectId("4");

export function launchEvent(
  kind: LaunchpadEventKind,
  fields: Record<string, unknown> = {},
  timestamp = start + 1000,
  memeType = meme,
): FixtureEvent {
  const defaults: Record<string, unknown> = {
    id: launchId,
    typeName: meme,
    address: objectId("5"),
    u64: 0n,
    u32: 0,
    u8: 9,
    bool: false,
    optionId: null,
    bytes: new Uint8Array(),
    string: "",
    creatorRecipient: { kind: "address", address: objectId("5") },
    allocationPlan: {
      curveMemeBps: 1000n,
      lpMemeBps: 9000n,
      lpQuoteBps: 10000n,
      protocolMemeBps: 0n,
      protocolQuoteBps: 0n,
      recipients: [],
    },
    feeSplit: ownerSplit,
  };
  const payload = {
    ...Object.fromEntries(
      Object.entries(launchpadEventSpecs[kind]).map(([key, descriptor]) => [
        key,
        defaults[descriptor],
      ]),
    ),
    ...fields,
  };
  const bcs = (launchpadEventBcs[kind] as BcsType<unknown, unknown>).serialize(payload).toBytes();
  return receipt(
    `${profile.launchpad_original_package}::events::${kind}${kind === "LaunchTicketCreated" ? `<${memeType}>` : `<${memeType},${quote}>`}`,
    bcs,
    timestamp,
  );
}

export function presaleEvent(
  kind: PresaleEventKind,
  fields: Record<string, unknown>,
  timestamp = start + 2000,
): FixtureEvent {
  const module = kind === "PresaleCreated" ? "blast_presale" : "events";
  return receipt(
    `${profile.presale_original_package}::${module}::${kind}<${meme},${quote}>`,
    (presaleEventBcs[kind] as BcsType<unknown, unknown>).serialize(fields).toBytes(),
    timestamp,
  );
}

export function creation(partnered = false): FixtureEvent[] {
  return [
    launchEvent("LaunchTicketCreated", {}, start - 2000),
    launchEvent(
      "LaunchCreated",
      { creation_fee: 100n, partner_id: partnered ? objectId("6") : null },
      start + 100,
    ),
  ];
}

function receipt(event_type: string, bcs: Uint8Array, timestamp: number): FixtureEvent {
  return {
    checkpoint: "101",
    tx_slot: "1",
    event_slot: "0",
    timestamp_ms: String(timestamp),
    tx_digest: "fixture-native-transaction",
    sender: objectId("5"),
    event_type,
    bcs,
  };
}

const ownerSplit: FeeSplit = { routes: [{ destination: { kind: "Owner" }, bps: 10_000n }] };

export function vaultEvent(kind: VaultEventKind, fields: Record<string, unknown> = {}): FixtureEvent {
  const vaultId = objectId("9");
  const defaults: Record<string, unknown> = {
    vault_id: vaultId,
    pool_id: objectId("a"),
    position_id: objectId("d"),
    liquidity: 100n,
    terms: {
      origin: launchId,
      packageWitness: `${profile.launchpad_original_package}::blast_fun::PackageWitness`,
      feeSplit: ownerSplit,
      protocolMemeBps: 1000n,
      protocolQuoteBps: 1000n,
      partnerId: null,
      residuals: "Owner",
    },
    residual_meme_amount: 0n,
    residual_quote_amount: 0n,
    gross_meme_amount: 0n,
    gross_quote_amount: 0n,
    protocol_meme_amount: 0n,
    protocol_quote_amount: 0n,
    route_meme_amounts: [0n],
    route_quote_amounts: [0n],
    meme_amount: 0n,
    quote_amount: 0n,
    auto_lp_meme_pending: 0n,
    auto_lp_quote_pending: 0n,
    quote_spent: 0n,
    meme_burned: 0n,
    burn_quote_pending: 0n,
  };
  const venue = kind === "VaultCreated" ? `,${objectId("a")}::cetus::Venue` : "";
  return receipt(
    `${profile.vault_original_package}::blast_vault_events::${kind}<${meme},${quote}${venue}>`,
    (vaultEventBcs[kind] as BcsType<unknown, unknown>).serialize({ ...defaults, ...fields }).toBytes(),
    start + 3000,
  );
}

export function feeSplitApplied(value: FeeSplit): FixtureEvent {
  const type = `${profile.core_original_package}::fee_split::FeeSplit`;
  return receipt(
    `${profile.admin_original_package}::delayed::DelayedApplied<${profile.vault_original_package}::vault::FeeSplitKey,${type}>`,
    delayedEventBcs("DelayedApplied", vaultDelayedKeys.FeeSplit).serialize({
      parent: objectId("9"), key: null, previous_value: ownerSplit, value, delay_ms: 1n,
    }).toBytes(),
    start + 3000,
  );
}

export function feePayment(
  product: "launch" | "presale" | "vault",
  fields: Partial<ProtocolFeesPaid> = {},
): FixtureEvent {
  const witness = {
    launch: `${profile.launchpad_original_package}::blast_fun::PackageWitness`,
    presale: `${profile.presale_original_package}::blast_presale_package::PackageWitness`,
    vault: `${profile.vault_original_package}::vault::VaultWitness`,
  };
  return receipt(
    `${profile.core_original_package}::blast_core_events::ProtocolFeesPaid<${meme},${quote}>`,
    protocolFeesPaidBcs.serialize({
      package_witness: witness[product], origin: launchId, treasury: objectId("8"),
      meme_amount: 0n, quote_amount: 0n, sui_amount: 0n, partner_id: null,
      partner_meme_amount: 0n, partner_quote_amount: 0n, partner_sui_amount: 0n,
      ...fields,
    }).toBytes(),
    start + 2000,
  );
}
