import { SUI_COIN_TYPE as SUI } from "@blast/core/lib/sui/coin-types.ts";
import {
  decodeLaunchpadEvent,
  type DecodedLaunchpadEvent,
} from "@interest-protocol/blast-sdk/launchpad";
import { decodePresaleEvent, type DecodedPresaleEvent } from "@interest-protocol/blast-sdk/presale";
import { decodeProtocolFeesPaid, type DecodedProtocolFeesPaid } from "@interest-protocol/blast-core/protocol-fees";
import { decodeDelayedEvent } from "@interest-protocol/blast-sdk/admin";
import { feeSplitBcs, type FeeSplit } from "@interest-protocol/blast-core/fee-split";
import { decodeVaultEvent, vaultDelayedKeys, type DecodedVaultEvent } from "@interest-protocol/blast-sdk/vault";
import { normalizeStructTag, parseStructTag } from "@mysten/sui/utils";
import type { FrontendFee } from "./frontend-fees.ts";
import { vaultIncome, type VaultIncome } from "./vault-accounting.ts";
import {
  METRICS,
  type Amounts,
  type Contract,
  type Coverage,
  type Item,
  type ScopeCoverage,
  type Profile,
} from "./contracts.ts";

export type NativeEvent = {
  checkpoint: string;
  tx_slot: string;
  event_slot: string;
  timestamp_ms: string;
  tx_digest: string;
  sender: string;
  event_type: string;
  bcs: Uint8Array | null;
};
type Launch = { meme: string; quote: string; partnered: boolean };
type Vault = Launch & { split: FeeSplit };
export type NativeReplayState = {
  tickets: [string, string][];
  launches: [string, Launch][];
  vaults: [string, Launch & { split: string }][];
};

type Totals = { item: Item; amounts: Record<string, bigint>; unresolved: boolean };

function isVaultFeeSplitApplied(tag: ReturnType<typeof parseStructTag>, profile: Profile): boolean {
  const [key] = tag.typeParams;
  return tag.address === profile.admin_original_package && tag.module === "delayed" &&
    tag.name === "DelayedApplied" && typeof key === "object" &&
    normalizeStructTag(key) === `${profile.vault_original_package}::vault::FeeSplitKey`;
}

/** Replay native receipts once in canonical order; only the selected day earns amounts. */
export class DefillamaAccounting {
  readonly #profile: Profile;
  readonly #start: number;
  readonly #end: number;
  readonly #tickets = new Map<string, string>();
  readonly #launches = new Map<string, Launch>();
  readonly #vaults = new Map<string, Vault>();
  readonly #contracts = new Map<string, Contract>();
  readonly #totals = new Map<string, Totals>();

  constructor(profile: Profile, start: number, end: number) {
    this.#profile = profile;
    this.#start = start;
    this.#end = end;
  }

  restore(state: NativeReplayState, contracts: readonly Contract[]): void {
    for (const [id, meme] of state.tickets) this.#tickets.set(id, meme);
    for (const [id, launch] of state.launches) this.#launches.set(id, launch);
    for (const [id, vault] of state.vaults) {
      this.#vaults.set(id, { ...vault, split: feeSplitBcs.fromBase64(vault.split) });
    }
    for (const contract of contracts) this.#contracts.set(contract.object_id, contract);
  }

  replayState(): NativeReplayState {
    return {
      tickets: [...this.#tickets],
      launches: [...this.#launches],
      vaults: [...this.#vaults].map(([id, vault]) => [
        id, { ...vault, split: feeSplitBcs.serialize(vault.split).toBase64() },
      ]),
    };
  }

  apply(row: NativeEvent): void {
    if (row.bcs === null) {
      throw new Error("Native receipt exceeds the reporting size limit");
    }
    const tag = parseStructTag(row.event_type);
    const event = {
      eventType: row.event_type,
      bcs: row.bcs,
      sender: row.sender,
      packageId: tag.address,
      module: tag.module,
      json: null,
      checkpoint: row.checkpoint,
      transactionDigest: row.tx_digest,
      eventIndex: Number(row.event_slot),
    };
    const timestamp = Number(row.timestamp_ms);
    const originalPackageId = tag.address;
    const profile = this.#profile;
    if (tag.address === profile.launchpad_original_package && tag.module === "events") {
      this.#launchpad(decodeLaunchpadEvent(event, { originalPackageId }), timestamp);
    } else if (tag.address === profile.presale_original_package &&
      (tag.module === "events" || (tag.module === "blast_presale" && tag.name === "PresaleCreated"))) {
      this.#presale(decodePresaleEvent(event, { originalPackageId }), timestamp);
    } else if (tag.address === profile.vault_original_package && tag.module === "blast_vault_events") {
      this.#vault(decodeVaultEvent(event, { originalPackageId }), timestamp);
    } else if (tag.address === profile.core_original_package &&
      tag.module === "blast_core_events" && tag.name === "ProtocolFeesPaid") {
      this.#paid(decodeProtocolFeesPaid(event, { originalPackageId }), timestamp);
    } else if (isVaultFeeSplitApplied(tag, profile)) {
      this.#feeSplitApplied(event);
    }
  }

  #feeSplitApplied(event: Parameters<typeof decodeDelayedEvent>[0]): void {
    const profile = this.#profile;
    const applied = decodeDelayedEvent(event, {
      adminPackageId: profile.admin_original_package,
      packageId: profile.vault_original_package,
      keys: {
        FeeSplit: {
          ...vaultDelayedKeys.FeeSplit,
          valueType: `${profile.core_original_package}::fee_split::FeeSplit`,
        },
      },
    });
    if (applied.name === "FeeSplit" && applied.kind === "DelayedApplied") {
      const vault = this.#vaults.get(applied.payload.parent);
      if (!vault) throw new Error("Vault fee split history is incomplete");
      vault.split = applied.payload.value;
    }
  }

  addFrontendFees(fees: readonly FrontendFee[]): void {
    for (const { venue, coin, amount } of fees) {
      this.#fee("frontend_router_fees", coin, amount, 0n, false, "payment");
      this.#add("frontend_router_fees", coin, `${venue}_paid`, amount, true, "payment");
    }
  }

  result(): { items: Item[]; contracts: Contract[]; coverage: Coverage; scope_coverage: ScopeCoverage } {
    const items = [...this.#totals.values()]
      .map(({ item, amounts, unresolved }) => {
        for (const key of METRICS) {
          if (
            item.included_in_totals &&
            key !== "holders_revenue" &&
            !(unresolved && ["supply_side_revenue", "revenue", "protocol_revenue"].includes(key))
          ) {
            item.metrics[key] = (amounts[key] ?? 0n).toString();
          }
        }
        item.evidence = Object.fromEntries(
          Object.entries(amounts)
            .filter(([key]) => !METRICS.includes(key as keyof Amounts))
            .map(([key, amount]) => [key, amount.toString()]),
        );
        return item;
      })
      .sort((a, b) =>
        `${a.component}:${a.coin_type}`.localeCompare(`${b.component}:${b.coin_type}`),
      );
    const launchUnresolved = items.some((item) => item.included_in_totals &&
      item.component !== "frontend_router_fees" &&
      item.accounting_basis !== "collection" && item.metrics.revenue === null);
    const vaultUnresolved = items.some((item) => item.included_in_totals &&
      item.accounting_basis === "collection" && item.metrics.revenue === null);
    const coverage = metricCoverage(launchUnresolved || vaultUnresolved);
    return {
      items,
      contracts: [...this.#contracts.values()].sort((a, b) =>
        a.object_id.localeCompare(b.object_id),
      ),
      coverage,
      scope_coverage: {
        launchpad: metricCoverage(launchUnresolved),
        frontend_router: metricCoverage(false, "external_venue_volume_excluded"),
        vault_yield: metricCoverage(vaultUnresolved, "vault_yield_has_no_trading_volume"),
      },
    };
  }

  #launchpad(event: DecodedLaunchpadEvent, timestamp: number): void {
    const p = event.payload;
    if (event.kind === "LaunchTicketCreated" && event.memeType) {
      this.#tickets.set(event.payload.ticket_id, event.memeType);
      return;
    }
    if (event.kind === "LaunchCreated" && event.memeType && event.quoteType) {
      const { payload, memeType: meme, quoteType: quote } = event;
      if (this.#tickets.get(payload.ticket_id) !== meme) {
        throw new Error("Launch ticket history is incomplete");
      }
      const launch = { meme, quote, partnered: payload.partner_id !== null };
      this.#launches.set(payload.launch_id, launch);
      this.#register(payload.launch_id, "curve", meme, quote, timestamp);
      if (this.#included(meme, timestamp)) {
        this.#fee("creation", SUI, payload.creation_fee, 0n, launch.partnered);
      }
      return;
    }
    if (!("launch_id" in p)) {
      return;
    }
    const launch = this.#launches.get(p.launch_id);
    if (!launch) {
      throw new Error("Launch history is incomplete");
    }
    if (!this.#included(launch.meme, timestamp)) {
      return;
    }
    if (event.kind === "Bought" || event.kind === "Sold") {
      this.#curveSwap(event, launch);
    } else if (event.kind === "ProtocolFeesAccrued") {
      this.#evidence(
        "migration_minted_allocations",
        launch.meme,
        "allocated",
        BigInt(event.payload.meme_amount),
        "execution",
      );
      this.#fee(
        "migration",
        launch.quote,
        BigInt(event.payload.quote_amount),
        0n,
        launch.partnered,
      );
    }
  }

  #curveSwap(event: Extract<DecodedLaunchpadEvent, { kind: "Bought" | "Sold" }>, launch: Launch): void {
    const p = event.payload;
    const quoteFee = BigInt(p.protocol_quote_fee) + BigInt(p.creator_quote_fee);
    const volume =
      event.kind === "Bought"
        ? BigInt(event.payload.quote_in)
        : BigInt(event.payload.quote_out_gross);
    if (event.kind === "Sold" && quoteFee > volume) {
      throw new Error("Invalid quote volume");
    }
    this.#add("curve_swaps", launch.quote, "volume", volume);
    this.#fee(
      "curve_swaps",
      launch.quote,
      BigInt(p.protocol_quote_fee),
      BigInt(p.creator_quote_fee),
      launch.partnered,
    );
    this.#fee(
      "curve_swaps",
      launch.meme,
      BigInt(p.protocol_meme_fee),
      BigInt(p.creator_meme_fee),
      launch.partnered,
    );
  }

  #presale(event: DecodedPresaleEvent, timestamp: number): void {
    if (event.kind === "PresaleCreated") {
      this.#register(event.payload.presale_id, "presale", event.saleTokenType, event.quoteType, timestamp);
    }
  }

  #vault(event: DecodedVaultEvent, timestamp: number): void {
    const { memeType: meme, quoteType: quote } = event;
    if (event.kind === "VaultCreated") {
      const p = event.payload;
      this.#vaults.set(p.vault_id, { meme, quote, partnered: p.terms.partnerId !== null, split: p.terms.feeSplit });
      this.#register(p.vault_id, "vault", meme, quote, timestamp);
      if (this.#included(meme, timestamp)) {
        this.#evidence("migration_residuals", meme, "principal_received", p.residual_meme_amount, "execution");
        this.#evidence("migration_residuals", quote, "principal_received", p.residual_quote_amount, "execution");
      }
      return;
    }
    if (event.kind !== "FeesCollected" && event.kind !== "OwnerBalancesClaimed") return;
    const vault = this.#vaults.get(event.payload.vault_id);
    if (!vault || vault.meme !== meme || vault.quote !== quote) throw new Error("Vault history is incomplete");
    if (!this.#included(meme, timestamp)) return;
    if (event.kind === "FeesCollected") {
      for (const row of vaultIncome(event.payload, meme, quote, vault.split)) {
        this.#collected(row, vault.partnered);
      }
    } else {
      this.#evidence("vault_owner_withdrawals", meme, "owner_withdrawn", event.payload.meme_amount, "payment");
      this.#evidence("vault_owner_withdrawals", quote, "owner_withdrawn", event.payload.quote_amount, "payment");
    }
  }

  #paid(event: DecodedProtocolFeesPaid, timestamp: number): void {
    const { memeType: meme, quoteType: quote, payload: p } = event;
    if (!this.#included(meme, timestamp)) return;
    const witness = normalizeStructTag(p.package_witness);
    const profile = this.#profile;
    if (witness === `${profile.presale_original_package}::blast_presale_package::PackageWitness`) {
      this.#fee("presale_raise", quote, p.quote_amount, p.partner_quote_amount, false, "payment", "partner_paid");
      this.#evidence("presale_minted_allocations", meme, "allocated", p.meme_amount + p.partner_meme_amount, "payment");
      return;
    }
    const component = witness === `${profile.launchpad_original_package}::blast_fun::PackageWitness`
      ? "curve_settlements"
      : witness === `${profile.vault_original_package}::vault::VaultWitness` ? "vault_settlements" : null;
    if (component === null) return;
    for (const [coin, net, partner] of [
      [meme, p.meme_amount, p.partner_meme_amount],
      [quote, p.quote_amount, p.partner_quote_amount],
      [SUI, p.sui_amount, p.partner_sui_amount],
    ] as const) {
      this.#evidence(component, coin, "treasury_paid", net, "payment");
      this.#evidence(component, coin, "partner_paid", partner, "payment");
    }
  }

  #collected(row: VaultIncome, partnered: boolean): void {
    const component = "vault_collections";
    const supply = Object.values(row.allocations).reduce((sum, value) => sum + value, 0n);
    if (row.gross !== row.protocol + supply) throw new Error("Vault collection does not reconcile");
    this.#fee(component, row.coin, row.protocol, supply, partnered, "collection", "supply_side_allocated");
    this.#evidence(component, row.coin, "gross_income", row.gross, "collection");
    this.#evidence(
      component,
      row.coin,
      partnered ? "protocol_held_for_partner_settlement" : "protocol_paid",
      row.protocol,
      "collection",
    );
    for (const [key, amount] of Object.entries(row.allocations)) {
      this.#evidence(component, row.coin, key, amount, "collection");
    }
  }

  #register(
    id: string,
    kind: Contract["kind"],
    meme: string,
    quote: string,
    timestamp: number,
  ): void {
    if (this.#profile.excluded_meme_packages.includes(meme.split("::")[0]!)) {
      return;
    }
    if (this.#contracts.has(id)) {
      throw new Error("Duplicate contract creation");
    }
    this.#contracts.set(id, {
      object_id: id,
      kind,
      meme_type: meme,
      quote_type: quote,
      created_timestamp_ms: timestamp,
      tvl: kind === "vault" ? "requires_attribution_review" : "read_user_quote_custody",
    });
  }

  #included(meme: string, timestamp: number): boolean {
    return (
      timestamp >= this.#start &&
      timestamp < this.#end &&
      !this.#profile.excluded_meme_packages.includes(meme.split("::")[0]!)
    );
  }

  #fee(
    component: string,
    coin: string,
    protocol: bigint,
    supply: bigint,
    partnered: boolean,
    basis: Item["accounting_basis"] = "execution",
    supplyClass = "creator_accrued",
  ): void {
    if (protocol + supply === 0n) {
      return;
    }
    const t = this.#add(component, coin, "fees", protocol + supply, true, basis);
    this.#add(component, coin, "supply_side_revenue", supply, true, basis);
    this.#add(component, coin, "revenue", protocol, true, basis);
    this.#add(component, coin, "protocol_revenue", protocol, true, basis);
    this.#add(component, coin, supplyClass, supply, true, basis);
    this.#add(
      component,
      coin,
      basis === "payment" ? "protocol_paid" : "protocol_accrued",
      protocol,
      true,
      basis,
    );
    t.unresolved ||= partnered && protocol > 0n;
  }

  #evidence(
    component: string,
    coin: string,
    key: string,
    amount: bigint,
    basis: Item["accounting_basis"],
  ): void {
    if (amount > 0n) {
      this.#add(component, coin, key, amount, false, basis);
    }
  }

  #add(
    component: string,
    coin: string,
    key: string,
    amount: bigint,
    included = true,
    basis: Item["accounting_basis"] = "execution",
  ): Totals {
    if (amount < 0n) {
      throw new Error("Negative token amount");
    }
    const id = `${component}:${coin}`;
    let t = this.#totals.get(id);
    if (!t) {
      t = {
        item: {
          component,
          coin_type: coin,
          included_in_totals: included,
          underlying_venue_overlap: basis === "collection",
          accounting_basis: basis,
          metrics: Object.fromEntries(METRICS.map((m) => [m, null])) as Amounts,
          evidence: {},
        },
        amounts: {},
        unresolved: false,
      };
      this.#totals.set(id, t);
    }
    t.amounts[key] = (t.amounts[key] ?? 0n) + amount;
    return t;
  }
}

function metricCoverage(unresolved: boolean, noVolume?: string): Coverage {
  return Object.fromEntries(
    METRICS.map((metric) => [
      metric,
      metric === "holders_revenue"
        ? { status: "not_applicable", reason: "no_blast_governance_holder_mechanism" }
        : metric === "volume" && noVolume
          ? { status: "not_applicable", reason: noVolume }
          : unresolved && ["supply_side_revenue", "revenue", "protocol_revenue"].includes(metric)
            ? { status: "unavailable", reason: "mutable_deferred_partner_allocation" }
            : { status: "complete", reason: null },
    ]),
  ) as Coverage;
}
