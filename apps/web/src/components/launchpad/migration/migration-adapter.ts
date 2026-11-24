import { SUI_COIN_TYPE as SUI } from "@blast/core/lib/sui/coin-types.ts";
import { safeErrorCode } from "#web/lib/errors.ts";
// The public Complete migration action. Anyone may migrate a MigrationReady
// launch; this adapter reads the launch, its recorded route and venue, and
// that venue's recorded objects fresh from the node, previews the
// consequences, and builds the call with the SDK's `migrateCetus` or
// `migrateBluefin`. Venue objects come only from the deployment manifest
// (`resolveVenueObjects`); nothing here chooses another venue.

import {
  getBluefinPoolCreationFee,
  launchpadDeployment,
  migratorsDeployment,
  resolveVenueObjects,
  type BlastDeployment,
  type BluefinVenueObjects,
  type CetusVenueObjects,
} from "@interest-protocol/blast-sdk/deployments";
import { decodeLaunchObject, LaunchpadTransactions, type LaunchLifecycle, type LaunchState } from "@interest-protocol/blast-sdk/launchpad";
import {
  MigratorsClient,
  venueOf,
  type MigratorVenue,
} from "@interest-protocol/blast-sdk/migrators";
import type { CetusMemeSide } from "@interest-protocol/blast-sdk";
import { parseStructTag } from "@mysten/sui/utils";

import { cetusMemeSide } from "@blast/core/lib/launchpad/cetus-coin-order.ts";
import { readCetusFees } from "../launch/cetus-tiers.ts";
import { findCurrencyRegistration, type SharedObjectFacts } from "../launch/chain-facts.ts";
import type { MaterialFact } from "../transaction/action-machine.ts";
import type { EnabledAccess, LaunchpadActionAdapter, RequiredObject } from "../transaction/preflight.ts";
import { venueName } from "@blast/core/lib/format.ts";
import { VENUE_PRODUCTS } from "@blast/core/modules/launchpad-contract/venues.ts";
import { atomsText } from "@blast/core/web/format.ts";

export type MigrationInput = Readonly<{ launchId: string }>;

/** The launch's recorded route as this app can sign it now. */
export type MigrationRoute =
  | Readonly<{ status: "supported"; venue: MigratorVenue }>
  | Readonly<{ status: "unsupported"; message: string }>;

type VenueSetup =
  | Readonly<{ venue: "cetus"; memeSide: CetusMemeSide; objects: CetusVenueObjects["migrate"] }>
  | Readonly<{
      venue: "bluefin";
      objects: BluefinVenueObjects["migrate"];
      quoteCurrency: SharedObjectFacts;
      /** Bluefin's configured SUI pool-creation fee, in MIST, read now. */
      creationFee: bigint;
      /** The signer's SUI, in MIST. */
      balance: bigint;
    }>;

export type MigrationFresh = Readonly<{
  launch: LaunchState;
  route: MigrationRoute;
  /** What the venue's call needs; null unless the launch is MigrationReady on a supported route. */
  setup: (Readonly<{ memeCurrency: SharedObjectFacts; tickSpacing: number; feeRate: bigint }> & VenueSetup) | null;
}>;

/**
 * SUI kept for the network fee when Bluefin's fee is split from the same gas
 * coin: the fixed budget a migration's simulation is expected to stay under.
 * A fee-free migration needs no reserve here; its simulation checks gas.
 */
export const BLUEFIN_GAS_RESERVE_MIST = 50_000_000n;
const NO_ALTERNATIVE = "Nothing was signed, and Blast offers no other venue.";

const LIFECYCLE_TEXT: Readonly<Record<LaunchLifecycle, string>> = {
  OpeningRound: "in its opening round",
  Live: "Live",
  MigrationReady: "migration ready",
  Migrated: "migrated",
};

function symbol(coinType: string): string {
  return parseStructTag(coinType).name;
}

function sui(mist: bigint): string {
  return `${atomsText(mist, 9)} SUI`;
}

/** The launch's recorded route, refused unless the SDK routes it, the deployment admits it, and its venue set is available. */
export function migrationRoute(launch: LaunchState, deployment: BlastDeployment, access: EnabledAccess): MigrationRoute {
  const migrators = deployment.packages.migrators;
  if (!migrators) return { status: "unsupported", message: `This deployment has no migrators package. ${NO_ALTERNATIVE}` };
  const venue = venueOf(migrators, launch.venue);
  if (!venue) {
    const recorded = parseStructTag(launch.venue).module;
    return {
      status: "unsupported",
      message: `This launch records the ${recorded} migration route, which this app cannot sign. ${NO_ALTERNATIVE}`,
    };
  }
  if (!deployment.routes.some((route) => route.venue === venue)) {
    return { status: "unsupported", message: `This deployment does not admit ${venueName(venue)} migrations. ${NO_ALTERNATIVE}` };
  }
  const availability = access.venues[venue];
  if (!availability.available) {
    const reasons = availability.reasons.map((reason) => safeErrorCode(reason.code, "deployment-rejected")).join("; ");
    return {
      status: "unsupported",
      message: `${venueName(venue)} migration is unavailable: this deployment's recorded ${venueName(venue)} objects cannot be used (${reasons}). ${NO_ALTERNATIVE}`,
    };
  }
  return { status: "supported", venue };
}

async function registryCurrency(client: Parameters<typeof findCurrencyRegistration>[0], coinType: string) {
  const currency = await findCurrencyRegistration(client, coinType);
  if (!currency) throw new Error(`The Coin Registry has no shared currency for ${coinType}.`);
  return currency;
}

/**
 * Complete migration: permissionless, signed by the connected wallet, built
 * by the SDK for the launch's recorded venue. Success needs the launchpad's
 * `Migrated` event in the checkpointed transaction.
 */
export const migrationAdapter: LaunchpadActionAdapter<MigrationInput, MigrationFresh> = {
  action: "complete-migration",
  async readFresh({ client, deployment, access, signer, input }) {
    const { objects } = await client.core.getObjects({ objectIds: [input.launchId], include: { content: true } });
    const object = objects[0];
    if (!object || object instanceof Error) {
      return { objects: [{ role: "The launch", objectId: input.launchId, type: null, lineage: "launchpad" }], value: null };
    }
    const required: RequiredObject[] = [{ role: "The launch", objectId: object.objectId, type: object.type, lineage: "launchpad" }];
    const tag = parseStructTag(object.type);
    if (object.owner.$kind !== "Shared" || tag.module !== "launch" || tag.name !== "Launch") return { objects: required, value: null };
    const launch = decodeLaunchObject({
      objectId: object.objectId,
      initialSharedVersion: object.owner.Shared.initialSharedVersion,
      mutable: true,
      type: object.type,
      content: object.content,
    });
    const route = migrationRoute(launch, deployment, access);
    if (launch.lifecycle !== "MigrationReady" || route.status !== "supported") {
      return { objects: required, value: { launch, route, setup: null } };
    }
    const tiers = deployment.routes.find((entry) => entry.venue === route.venue)?.tiers ?? [];
    const migrators = new MigratorsClient(client, migratorsDeployment(deployment));
    const memeCurrency = await registryCurrency(client, launch.memeType);
    if (route.venue === "cetus") {
      const { migrate } = resolveVenueObjects(access, "cetus");
      const [tickSpacing, fees] = await Promise.all([
        migrators.getCetusPoolTier(launch.memeType),
        readCetusFees(client, deployment),
      ]);
      const fee = tickSpacing === null ? undefined : fees[String(tickSpacing)];
      if (tickSpacing === null || !fee || !tiers.some((tier) => tier.tickSpacing === tickSpacing && tier.feeRate === fee)) {
        return { objects: required, value: { launch, route: { status: "unsupported", message: "The recorded Cetus tier is unavailable." }, setup: null } };
      }
      const memeSide = cetusMemeSide(launch.memeType, launch.quoteType);
      return { objects: required, value: { launch, route, setup: { venue: "cetus", memeCurrency, memeSide, objects: migrate, tickSpacing, feeRate: BigInt(fee) } } };
    }
    const { migrate } = resolveVenueObjects(access, "bluefin");
    const [quoteCurrency, creationFee, { balance }, tier] = await Promise.all([
      registryCurrency(client, launch.quoteType),
      getBluefinPoolCreationFee(client, deployment),
      client.core.getBalance({ owner: signer.address, coinType: SUI }),
      migrators.getBluefinPoolTier(launch.memeType),
    ]);
    if (!tier || !tiers.some((entry) => entry.tickSpacing === tier.tickSpacing && entry.feeRate === String(tier.feeRate))) {
      return { objects: required, value: { launch, route: { status: "unsupported", message: "The recorded Bluefin tier is unavailable." }, setup: null } };
    }
    return {
      objects: required,
      value: {
        launch,
        route,
        setup: { venue: "bluefin", memeCurrency, quoteCurrency, creationFee, balance: BigInt(balance.balance), objects: migrate, ...tier },
      },
    };
  },
  eligibility({ launch, route, setup }) {
    if (launch.lifecycle === "Migrated") {
      return { eligible: false, code: "stale-lifecycle", message: "Sui shows this launch as already migrated, so there is nothing to sign." };
    }
    if (launch.lifecycle !== "MigrationReady") {
      return {
        eligible: false,
        code: "stale-lifecycle",
        message: `This launch is ${LIFECYCLE_TEXT[launch.lifecycle]} on Sui, not ready to migrate. Nothing was signed.`,
      };
    }
    if (route.status !== "supported") return { eligible: false, code: "stale-route", message: route.message };
    if (setup?.venue === "bluefin" && setup.creationFee > 0n && setup.balance < setup.creationFee + BLUEFIN_GAS_RESERVE_MIST) {
      return {
        eligible: false,
        code: "insufficient-balance",
        message: `Bluefin charges ${sui(setup.creationFee)} to create the pool, and the network fee comes from the same SUI; your wallet holds ${sui(setup.balance)}. Add SUI to keep at least ${sui(setup.creationFee + BLUEFIN_GAS_RESERVE_MIST)}, then review again.`,
      };
    }
    return { eligible: true };
  },
  preview({ launch, setup }) {
    if (!setup) throw new Error("The migration has no venue setup.");
    const meme = symbol(launch.memeType);
    const quote = symbol(launch.quoteType);
    const facts: MaterialFact[] = [
      { key: "launch-state", label: "Launch", value: "Migration ready, read from Sui now" },
      {
        key: "route",
        label: "Recorded route",
        value: `${VENUE_PRODUCTS[setup.venue]}, tick spacing ${setup.tickSpacing}, fee rate ${setup.feeRate}`,
      },
    ];
    if (setup.venue === "cetus") {
      facts.push(
        {
          key: "pool",
          label: "Creates",
          value:
            setup.memeSide === "a"
              ? `New Cetus pool ${meme} / ${quote} (${meme} is coin A)`
              : `New Cetus pool ${quote} / ${meme} (${meme} is coin B)`,
        },
        { key: "position", label: "Liquidity", value: "The launch's full-range position, burned through Cetus LP Burn" },
        { key: "cost", label: "You pay", value: "Network fee only" },
      );
      return facts;
    }
    facts.push(
      { key: "pool", label: "Creates", value: `New Bluefin pool ${meme} / ${quote}` },
      { key: "position", label: "Liquidity", value: "The launch's full-range position, held by its vault with no withdrawal" },
      {
        key: "pool-creation-fee",
        label: "Bluefin pool-creation fee",
        value: `${sui(setup.creationFee)} (${setup.creationFee} MIST), paid by you to Bluefin`,
      },
      { key: "cost", label: "You pay", value: `${sui(setup.creationFee)} pool-creation fee plus the network fee` },
      { key: "manager", label: "Pool role", value: "Your wallet becomes the new pool's manager (its reward emissions only)" },
    );
    return facts;
  },
  build({ launch, setup }, { deployment }) {
    if (!setup) throw new Error("The migration has no venue setup.");
    const transactions = new LaunchpadTransactions(launchpadDeployment(deployment));
    const common = {
      memeType: launch.memeType,
      quoteType: launch.quoteType,
      launch: { objectId: launch.objectId, initialSharedVersion: launch.initialSharedVersion, mutable: true as const },
      currency: setup.memeCurrency,
    };
    if (setup.venue === "cetus") return transactions.migrate({ ...common, venue: "cetus", ...setup.objects });
    return transactions.migrate({
      ...common,
      venue: "bluefin",
      quoteCurrency: setup.quoteCurrency,
      bluefinConfig: setup.objects.bluefinConfig,
      creationFee: setup.creationFee,
    });
  },
  completion: { kind: "event", source: "launchpad", event: "Migrated" },
  affectedReads: (input) => [`launch:${input.launchId}`, `coin:${input.launchId}`],
};
