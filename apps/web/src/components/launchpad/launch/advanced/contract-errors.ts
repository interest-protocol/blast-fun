import { launchpadAbortName, type LaunchpadAbortName } from "@interest-protocol/blast-launchpad-sdk/aborts";
import type { BlastDeployment } from "@interest-protocol/blast-sdk/deployments";
import { normalizeSuiAddress } from "@mysten/sui/utils";

const LAUNCHPAD_REJECTIONS: Readonly<Partial<Record<LaunchpadAbortName, Readonly<{ field: string; constraint: string }>>>> = {
  EDecimalsNotAllowed: { field: "decimals", constraint: "Blast does not admit these decimals now" },
  EVenueNotAllowed: { field: "venue", constraint: "Blast does not admit this venue now" },
  EInvalidVenue: { field: "venue", constraint: "Blast does not admit this venue now" },
  EInvalidProtocolAllocation: { field: "allocation.memeTotal", constraint: "Blast's allocation leaves no room for the curve or the pool" },
  EInvalidShares: { field: "allocation.memeTotal", constraint: "the shares do not total 100%, or the curve or pool share is zero" },
  ERecipientCapacityReached: { field: "allocation.recipients", constraint: "a split names more than sixteen recipients" },
  EInvalidSellBurnBps: { field: "sellBurn", constraint: "the sell burn is above its ceiling" },
  EInvalidMemeQuotePair: { field: "quote", constraint: "the coin and the Quote are the same type" },
  EInvalidOpeningRound: { field: "openingRound", constraint: "the opening round is outside its bounds" },
  EInvalidGraduationTarget: { field: "graduationTarget", constraint: "the pool's share of the target rounds to zero" },
  ESlippageExceeded: { field: "purchase.minMemeOut", constraint: "your buy returns fewer tokens than your minimum" },
  EZeroTradeOutput: { field: "purchase.amount", constraint: "your buy returns no tokens" },
  EInvalidCreatorRecipient: { field: "creator", constraint: "the creator recipient is the zero address" },
  EInvalidAccountCommitment: { field: "creator", constraint: "the account commitment is not 32 bytes" },
  EQuoteNotAllowed: { field: "quote", constraint: "Blast does not admit this Quote now" },
  EInvalidVirtualQuote: { field: "virtualQuote", constraint: "the virtual Quote reserve is zero" },
  EZeroOpeningRoundBid: { field: "purchase.amount", constraint: "your bid is zero" },
};

const ALLOCATION_ABORTS: Readonly<Partial<Record<`${string}:${LaunchpadAbortName}`, Readonly<{ field: string; constraint: string }>>>> = {
  "plan:EInvalidShares": { field: "allocation.curve", constraint: "the curve's or the pool's share of the supply is zero" },
  "add_protocol:EInvalidShares": { field: "allocation.memeTotal", constraint: "the allocation shares with Blast's do not total 100%" },
  "add_protocol:ERecipientCapacityReached": { field: "allocation.recipients", constraint: "the plan names more than sixteen recipients" },
};

export type ContractRejection = Readonly<{ field: string; message: string }>;

export type LaunchpadAbort = Readonly<{ code: number; module: string; functionName: string }>;

/**
 * The launchpad abort a failure message reports, parsed from the Sui client's
 * wording, or null unless the abort is in this deployment's launchpad package
 * (by package or original package ID). Every abort-to-meaning mapping in the
 * app goes through this check.
 */
export function launchpadAbortOf(message: string, deployment: BlastDeployment): LaunchpadAbort | null {
  return abortIn(message, deployment.packages.launchpad);
}

/** The abort a failure message reports, when `reference` (by package or original package ID) raised it. */
export function abortIn(message: string, reference: Readonly<{ packageId: string; originalPackageId: string }> | undefined): LaunchpadAbort | null {
  const match = /abort code: (\d+), in '(0x[0-9a-fA-F]+)::(\w+)::(\w+)/.exec(message);
  if (!match || !reference) return null;
  const packages = [reference.packageId, reference.originalPackageId].map((id) => normalizeSuiAddress(id));
  if (!packages.includes(normalizeSuiAddress(match[2]!))) return null;
  return { code: Number(match[1]), module: match[3]!, functionName: match[4]! };
}

/**
 * The field a launchpad abort in `message` concerns, or null when the message
 * is not one (another package, an unknown code, or no abort at all).
 */
export function contractRejection(message: string, deployment: BlastDeployment): ContractRejection | null {
  const cetus = abortIn(message, deployment.packages.cetusClmm);
  if (cetus) {
    return {
      field: "tier",
      message:
        `Cetus refused this pool tier: it does not register this tick spacing or refuses the pair at it ` +
        `(abort ${cetus.code} in ${cetus.module}::${cetus.functionName}). Choose another tier or venue.`,
    };
  }
  const parsed = launchpadAbortOf(message, deployment);
  if (!parsed) return null;
  const { code } = parsed;
  const name = launchpadAbortName(code);
  if (!name) return null;
  const abort = (parsed.module === "allocation" ? ALLOCATION_ABORTS[`${parsed.functionName}:${name}`] : undefined) ?? LAUNCHPAD_REJECTIONS[name];
  if (!abort) return null;
  return { field: abort.field, message: `The contract refused this launch: ${abort.constraint} (abort ${code}).` };
}
