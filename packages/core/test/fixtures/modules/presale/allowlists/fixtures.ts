// Presale chain fixtures for the bind and proof route tests and local
// rehearsals: a fixture node that holds Presale objects laid out with the
// SDK's own BCS, for the web's fixture identity. Nothing here is a real sale.

import { createHash } from "node:crypto";

import { presaleBcs, type EligibilityPolicy } from "@interest-protocol/blast-sdk/presale";
import { ObjectError, type ClientWithCoreApi } from "@mysten/sui/client";

import { SUI_MAINNET_CHAIN_IDENTIFIER } from "../deployment/fixtures.ts";
import { presaleFixtureObjectId } from "../../../../../src/modules/presale/deployment/service.ts";

const PACKAGE = presaleFixtureObjectId("presale-package");
const MEME = `0x${"e".repeat(64)}::meme::MEME`;
const USDC = `0x${"d".repeat(64)}::usdc::USDC`;

/** A fixture presale ID: sha256 of its label, so every test sale has its own. */
export function fixturePresaleId(label: string): string {
  return `0x${createHash("sha256").update(`presale-fixture-sale-${label}`).digest("hex")}`;
}

/** A pending Bluefin-venue presale with `eligibility`, as its Move object's BCS. */
export function presaleContent(objectId: string, eligibility: EligibilityPolicy): Uint8Array {
  return presaleBcs
    .serialize({
      id: { id: { bytes: objectId } },
      presale_cap_id: { bytes: fixturePresaleId(`${objectId}-cap`) },
      lifecycle: "Pending",
      duration_ms: 86_400_000n,
      liquidity_window_ms: 3_600_000n,
      // A pending sale has no scheduled start yet; its windows derive from the start.
      start_ms: 0n,
      raise_target: 1_000_000n,
      eligibility,
      uncapped: null,
      hard_cap: null,
      // The pool tier is the venue's (`PoolTierReserved`, ADR 0111), not the sale's.
      venue: `${PACKAGE}::bluefin::Witness`,
      fee_split: { routes: [{ destination: { kind: "Owner" }, bps: 10000n }] },
      total_commitments: 0n,
      participants: 0n,
      quote: 0n,
      token_allocation: 1_000_000n,
      participant_vesting: null,
      sale_tokens: 1_000_000n,
      liquidity_tokens: 0n,
      recipient_payouts: [],
      recipient_tokens: 0n,
      raise_payouts: [],
      protocol_fees: { raiseBps: 0n, tokenBps: 0n, lpFeeMemeBps: 0n, lpFeeQuoteBps: 0n },
      protocol_quote: 0n,
      protocol_tokens: 0n,
      partner_id: null,
      fee_ledger: { packageWitness: `${PACKAGE}::blast_presale::PackageWitness`, origin: objectId, partnerId: null, meme: 0n, quote: 0n, sui: 0n },
    })
    .toBytes();
}

type FixtureObject = Readonly<{ type: string; content: Uint8Array; shared: boolean }>;

export type PresaleChainFixture = ClientWithCoreApi & {
  /** Every `getObject` call. */
  reads: number;
  /** Creates a presale of the fixture package with `eligibility`, as a creator would with the SDK. */
  createPresale(label: string, eligibility: EligibilityPolicy): string;
  /** Puts any other object at `objectId`: another package's type, or an owned object. */
  putObject(objectId: string, object: FixtureObject): void;
  /** Makes every read fail as an unreachable node would. */
  failing: boolean;
  core: ClientWithCoreApi["core"] & {
    getChainIdentifier(): Promise<{ chainIdentifier: string }>;
  };
};

/**
 * A Core API node for the web's fixture identity: it reports the fixture
 * chain identifier, and `getObject` answers the presales created on it, an
 * `ObjectError` (`notFound`) for any other ID, as the gRPC client does.
 */
export function presaleChainFixture(chainIdentifier = SUI_MAINNET_CHAIN_IDENTIFIER): PresaleChainFixture {
  const objects = new Map<string, FixtureObject>();
  const node = {
    reads: 0,
    failing: false,
    createPresale(label: string, eligibility: EligibilityPolicy) {
      const objectId = fixturePresaleId(label);
      objects.set(objectId, {
        type: `${PACKAGE}::blast_presale::Presale<${MEME}, ${USDC}>`,
        content: presaleContent(objectId, eligibility),
        shared: true,
      });
      return objectId;
    },
    putObject(objectId: string, object: FixtureObject) {
      objects.set(objectId, object);
    },
    core: {
      async getChainIdentifier() {
        return { chainIdentifier };
      },
      async getObject({ objectId }: { objectId: string }) {
        node.reads += 1;
        if (node.failing) throw new Error("fixture node unreachable");
        const found = objects.get(objectId);
        if (!found) throw new ObjectError("notExists", `Object ${objectId} not found`, { reason: "notFound", objectId });
        return {
          object: {
            objectId,
            owner: found.shared
              ? { $kind: "Shared", Shared: { initialSharedVersion: "9" } }
              : { $kind: "AddressOwner", AddressOwner: `0x${"1".repeat(64)}` },
            type: found.type,
            content: found.content,
          },
        };
      },
    },
  };
  return node as unknown as PresaleChainFixture;
}
