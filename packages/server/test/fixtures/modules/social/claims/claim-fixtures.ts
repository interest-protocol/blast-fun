import { presaleEventBcs, presaleEventModules } from "@interest-protocol/blast-sdk/presale";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";

import type { PresaleRuntimeIdentity } from "../../../../../../core/src/modules/presale/deployment/contracts.ts";
import { presaleIdentityFixture, SUI_MAINNET_CHAIN_IDENTIFIER } from "../../../../../../core/test/fixtures/modules/presale/deployment/fixtures.ts";
import { parsePresaleRuntimeIdentity } from "../../../../../../core/src/modules/presale/deployment/service.ts";
import type { LinearVestingSchedule } from "../../../../../../core/src/modules/sponsor/linear-vesting.ts";
import type { ClaimChain, ClaimedEvent, ClaimPresale, ClaimSimulation, ExecutedClaim, VestingClaimedEvent } from "@blast/server/modules/social/claims/chain.ts";

/**
 * The claim transaction's test doubles (R3-63), for unit and integration
 * tests only — never imported by application code: a **mainnet** presale
 * identity over the deployment fixture's hash-derived ids (no real
 * deployment), a stub `ClaimChain` whose dry runs and executions the test
 * sets, and the BCS of a `blast_presale::Claimed` event. Nothing here reaches
 * a network.
 */

/** A mainnet identity as `PRESALE_DEPLOYMENT_MANIFEST` would carry it, parsed with the test rules (fixture ids allowed). */
export function claimTestIdentity(): PresaleRuntimeIdentity {
  return parsePresaleRuntimeIdentity(presaleIdentityFixture({ network: "mainnet", chainIdentifier: SUI_MAINNET_CHAIN_IDENTIFIER }), {
    production: false,
  });
}

/** A `Claimed` event of `identity`'s presale package, as a node returns it. */
export function claimedEventEntry(
  identity: PresaleRuntimeIdentity,
  types: Readonly<{ saleToken: string; quote: string }>,
  event: Readonly<{ presaleId: string; participant: string; tokens?: string; quoteRefund?: string; commitment?: string }>,
): Readonly<{ eventType: string; bcs: Uint8Array }> {
  return {
    eventType: `${normalizeSuiAddress(identity.presale.originalPackageId)}::${presaleEventModules.Claimed}::Claimed<${normalizeStructTag(types.saleToken)}, ${normalizeStructTag(types.quote)}>`,
    bcs: presaleEventBcs.Claimed.serialize({
      presale_id: normalizeSuiAddress(event.presaleId),
      participant: normalizeSuiAddress(event.participant),
      wallet_commitment: BigInt(event.commitment ?? "250000000"),
      tokens: BigInt(event.tokens ?? "0"),
      quote_refund: BigInt(event.quoteRefund ?? "250000000"),
      // Generation 2: the wallets still holding a commitment after this claim, and its vesting (none here).
      remaining_participants: 0n,
      vesting_id: null,
    }).toBytes(),
  };
}

export type StubClaimChain = ClaimChain & {
  /** The sales the stub knows, by id; any other is "not this deployment's". */
  presales: Map<string, ClaimPresale>;
  /** The vesting schedules the stub knows, by id (P-13). */
  vestings: Map<string, LinearVestingSchedule>;
  /** What every dry run answers. */
  simulation: ClaimSimulation;
  /** Executed transactions by digest; any other digest is not visible yet. */
  executions: Map<string, ExecutedClaim>;
  /** Every node call fails while true. */
  down: boolean;
  calls: { presale: number; simulate: number; executed: number };
  simulated: { kind: Uint8Array; sender: string }[];
};

export function stubClaimChain(): StubClaimChain {
  const chain: StubClaimChain = {
    presales: new Map(),
    vestings: new Map(),
    simulation: { status: "success" },
    executions: new Map(),
    down: false,
    calls: { presale: 0, simulate: 0, executed: 0 },
    simulated: [],
    async presale(presaleId) {
      chain.calls.presale += 1;
      if (chain.down) throw new Error("UNAVAILABLE");
      return chain.presales.get(presaleId) ?? null;
    },
    async vesting(scheduleId) {
      chain.calls.presale += 1;
      if (chain.down) throw new Error("UNAVAILABLE");
      return chain.vestings.get(scheduleId) ?? null;
    },
    async simulate(kind, sender) {
      chain.calls.simulate += 1;
      if (chain.down) throw new Error("UNAVAILABLE");
      chain.simulated.push({ kind, sender });
      return chain.simulation;
    },
    async executed(digest) {
      chain.calls.executed += 1;
      if (chain.down) throw new Error("UNAVAILABLE");
      return chain.executions.get(digest) ?? null;
    },
  };
  return chain;
}

/** An executed claim that paid `participant` from `presaleId`. */
export function executedClaim(
  input: Readonly<{
    sender: string;
    claims?: readonly ClaimedEvent[];
    vestingClaims?: readonly VestingClaimedEvent[];
    success?: boolean;
    moveAbort?: string | null;
    timestampMs?: number | null;
  }>,
): ExecutedClaim {
  const success = input.success ?? true;
  return {
    success,
    sender: normalizeSuiAddress(input.sender),
    failure: success ? null : { moveAbort: input.moveAbort ?? null, reason: input.moveAbort ?? "external_abort" },
    claims: input.claims ?? [],
    vestingClaims: input.vestingClaims ?? [],
    timestampMs: input.timestampMs ?? null,
  };
}
