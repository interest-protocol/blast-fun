import { presaleAbortName, type PresaleAbortName } from "@interest-protocol/blast-sdk/presale";
import type { SuiClientTypes } from "@mysten/sui/client";
import { normalizeSuiAddress } from "@mysten/sui/utils";

// Names are decoded using the deployed package's SDK registry.
const MESSAGES = {
  EUnguardedDelay: "The requested setting needs a notice period.",
  EVenueNotAllowed: "This liquidity venue is not allowed for new presales. Choose an allowed venue.",
  EInvalidVenue: "The requested venue is invalid.",
  EAboveFeePolicy: "The requested rates exceed the presale fee policy.",
  EProtocolFeesIncreased: "This operation may only reduce the stored presale rates.",
  EInvalidAssetPair: "The sale token and Quote type must differ.",
  EInvalidRaiseTarget: "The raise target must be positive.",
  EInvalidTokenAllocation: "The supply must be positive, and token allocations unique, positive, bounded, totalling exactly 10,000 BPS with Blast's share, and apportioning to positive amounts.",
  EInvalidWindow: "The commitment window must be positive, the liquidity window at least seven days, and both must end within u64 milliseconds.",
  EInvalidEligibilityPolicy: "The eligibility policy has an invalid cap, participant bound, root, or leaf count.",
  EInvalidLifecycle: "The presale is not in the lifecycle required by this operation.",
  EPresaleEnded: "The presale commitment window has ended.",
  EPresaleNotEnded: "The presale commitment window has not ended, and the sale cannot close early: its raise is not full under a hard cap that closes it when filled.",
  EZeroCommitment: "A presale commitment must be positive.",
  EWalletCapExceeded: "The wallet commitment exceeds its eligibility cap.",
  EParticipantCapacityReached: "The presale already contains its maximum number of participants.",
  EInvalidEligibilityProof: "The submitted wallet, cap, index, or proof does not match the allowlist.",
  EWrongEligibilityPolicy: "The commit function does not match the presale eligibility policy.",
  ETotalCommitmentOverflow: "Adding the commitment would overflow the presale total.",
  ENoCommitment: "The wallet has no undelivered presale commitment.",
  EWrongPresaleCap: "The creator capability belongs to a different presale vault.",
  ELiquidityDeadlineNotReached: "The deadline to cancel an unlaunched funded presale has not arrived.",
  EInitialSupplyNotZero: "The supplied SaleToken TreasuryCap must have zero total supply.",
  EInvalidFeeSplit: "Fee recipients must be unique, positive, unvested, bounded, and total 10,000 BPS with the holder-reward share.",
  EWrongMigrationWitness: "The migrator does not match the venue fixed at presale creation.",
  EBelowMinimumCommitment: "The wallet's total commitment is below the sale's minimum commitment.",
  EUnreachableRaise: "The minimum commitment times the slots held to it, the participant bound of an open policy or the open-to-anyone phase slots beyond any allowlist, must reach the raise target.",
  EUnseedablePrice: "The raise and LP-token allocation give a seed price the venues cannot pool.",
  EInvalidUncappedPhase: "An uncapped phase must start inside the window, and an open-to-anyone phase needs a positive minimum and a participant bound between the policy's and 65,536.",
  EUncappedPhaseNotOpen: "The presale has no uncapped phase open to any wallet, or it has not started.",
  EPresaleFilled: "The presale has already reached its raise under its hard cap.",
  EInvalidRaiseAllocation: "Raise allocations must be unique, positive, bounded, leave the LP a share after Blast's, and apportion to positive amounts.",
  EInvalidVestingTerms: "Vesting needs a positive period and period count, a cliff within its duration, and a duration of at most 2^63 milliseconds.",
  EPresaleNotStarted: "The presale commitment window has not started.",
  EPresaleStarted: "A presale's Blast rates can change only before its commitment window starts.",
  EProtocolFeesUnchanged: "A presale fee update must change its stored rates.",
  EWrongPartner: "The partner is not the one this vault's presale named at creation.",
  ENoPartnerPayout: "The presale holds no partner payout: it has not migrated, or its partner was already paid.",
  EInvalidHardCap: "A hard cap must start inside the commitment window.",
  EMissingSetting: "A presale needs its eligibility policy and LP-fee split set before it is finalized.",
  EWrongRound: "Round number must match the vault's next round.",
  EInvalidInterval: "Checkpoint interval must be nonempty and must not overlap a previous round.",
  EInvalidCommitment: "Root and manifest digest must contain 32 bytes.",
  EInvalidLeafCount: "Round must contain between 1 and 65,536 leaves.",
  EEmptyBudget: "A round must reserve a positive amount of at least one asset.",
  EInvalidIndex: "Claim index must be less than the committed leaf count.",
  EAlreadyClaimed: "This allocation has already been paid.",
  EInvalidBeneficiary: "Beneficiary must not be the zero address.",
  EInvalidProof: "Proof must match the committed beneficiary and amounts.",
  EInvalidClaimDeadline: "The claim deadline must be in the future.",
  EWrongVault: "The round belongs to a different presale vault.",
  EClaimsStillOpen: "The round's claim deadline has not passed.",
  EEmptyClaim: "A reward claim must pay a positive amount of at least one asset.",
  EInsufficientBudget: "Holder funding and gas reserve must fit the vault's available balances.",
  EReserveSettled: "Gas reimbursement is disabled or its reserve has already been settled.",
  EOverReserve: "Reimbursement must not exceed the bound gas reserve.",
  ETreasuryChanged: "The governed treasury must match the publication commitment.",
  EInvalidCoinOrder: "CoinA and CoinB must follow the Cetus coin order.",
  EPositionPoolMismatch: "Pool must be the one holding the position.",
  EWrongCoinPair: "CoinA and CoinB must be exactly the presale's Meme and Quote.",
  EInvalidTier: "Bluefin tier needs tick spacing 1..=400 and fee rate 1..=20,000.",
  ESymbolTooLong: "The Meme symbol must be at most 32 bytes for Bluefin migration.",
  ENoMigrationResiduals: "No migration residuals are available to claim.",
  EZeroLiquidity: "The vault's position must hold liquidity.",
  EProtocolLpFeesUnchanged: "An LP-fee update must change the vault's Blast rates.",
  EInvalidFees: "Blast's raise share must be below 10,000 BPS and its token share at most 9,998.",
  EFeesUnchanged: "A fee update must change the stored rates.",
  EInvalidDestination: "The protocol destination must be a new nonzero address.",
  EAllowanceUnchanged: "An allowlist update must change whether the type or partner is allowed.",
  EQuoteNotAllowed: "This coin is not allowed for new presales. Choose an allowed raise coin.",
  EMigrationWitnessNotAllowed: "This liquidity venue is not allowed for new presales. Choose an allowed venue.",
  EInvalidMigrationWitness: "A migration witness must be a non-framework struct, never a primitive, vector, or framework type any caller can construct.",
  EPartnerNotAccepted: "This partner is not accepted for new presales.",
  EPoolMismatch: "The Aftermath pool must hold every sale token and Quote unit the presale released.",
  EDaoFeePoolMismatch: "The DAO-fee pool must charge this module's fee and pay the vault.",
  EWrongPresale: "The pool creation is bound to a different presale.",
  EInvalidDaoFee: "Aftermath DAO fee needs 1..=10,000 basis points.",
  ESaleTokenNotUnregulated: "The sale currency must be confirmed unregulated; regulated and unknown legacy currencies are not allowed.",
  EInvalidBps: "A basis-points rate must be at most 10,000.",
} satisfies Readonly<Record<PresaleAbortName, string> & Record<string, string>>;

/** A named contract refusal from a server preflight or the sponsor's package-scoped abort map. */
export function presaleAbortMessage(name: unknown): string | null {
  return typeof name === "string" && Object.hasOwn(MESSAGES, name) ? MESSAGES[name as keyof typeof MESSAGES] : null;
}

export type PresaleErrorPackage = Readonly<{ package_id: string; original_package_id: string }>;

/** Decode only this deployment's aborts: other packages reuse the same modules and codes. */
export function presaleExecutionMessage(error: SuiClientTypes.ExecutionError | null | undefined, pkg: PresaleErrorPackage | undefined): string | null {
  if (error?.$kind !== "MoveAbort" || !pkg) return null;
  const abort = error.MoveAbort;
  const location = abort.location;
  if (!location?.package || !location.module) return null;
  const packages = [pkg.package_id, pkg.original_package_id].map((id) => normalizeSuiAddress(id));
  if (!packages.includes(normalizeSuiAddress(location.package))) return null;
  const code = abort.cleverError?.errorCode ?? (/^[0-9]{1,15}$/.test(abort.abortCode) ? Number(abort.abortCode) : null);
  if (code === null || !Number.isSafeInteger(code)) return null;
  return presaleAbortMessage(presaleAbortName(code));
}
