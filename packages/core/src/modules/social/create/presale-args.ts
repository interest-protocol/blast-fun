import { MAX_VESTING_DURATION_MS, type Route, type VestingTerms } from "@interest-protocol/blast-sdk";
import {
  PresaleAbortError,
  previewPresaleCreation,
  type EligibilityPolicy,
  type HardCap,
  type PresaleCreationConfig,
  type RecipientShare,
  type UncappedPhase,
} from "@interest-protocol/blast-sdk/presale";

import type {
  CreateAllowlistSummary,
  CreateDraft,
  CreateFeePolicy,
  CreateIssue,
  CreateRecipient,
  CreateSection,
} from "@blast/core/modules/social/contracts/create.ts";
import { presaleAbortMessage } from "@blast/core/modules/presale/abort-messages.ts";
import { draftIssues, draftQuote, venueTiers, type IssueContext } from "@blast/core/modules/social/create/model.ts";
import { presaleTargetDecimals } from "@blast/core/modules/social/create/minimum-raise.ts";
import { VESTING_UNIT_MS, vestingDurationMs, type VestingUnit } from "@blast/core/modules/social/contracts/vesting.ts";

/**
 * A finished draft as the arguments of `cetus::new` / `bluefin::new`
 * (blast_presale.move, newest contract: vesting shares, an optional uncapped
 * phase, `CreationPolicy`), in the contract's units: token atoms at the selected
 * precision, quote atoms in the draft's own coin (R3-42: USDC's 6 decimals or
 * SUI's 9), milliseconds, BPS.
 */

const DAY_MS = 86_400_000n;
const HOUR_MS = 3_600_000n;

export type CreatePresaleArgs = PresaleCreationConfig &
  Readonly<{
    burnable: boolean;
    venue: CreateDraft["venue"];
    /** R3-42: the coin the sale raises (the draft's `quote_type`). */
    quoteType: string;
    tickSpacing: number;
    /** Millionths; Cetus reads it from its own config for the spacing. */
    poolFeeRate: bigint;
    /** When commitments open (`blast_presale::share`): the draft's scheduled start, or 0 to open them at once. */
    startMs: bigint;
    /** The coin's metadata, for the coin's own package. */
    coin: Readonly<{ name: string; symbol: string; description: string; iconUrl: string; decimals: number }>;
  }>;

/** Dollars (at most two decimals) as USDC atoms, exactly. */
export function usdcAtoms(dollars: number): bigint {
  return quoteAtoms(dollars, 6);
}

/** An amount at the field's precision as atoms of the quote coin. */
export function quoteAtoms(amount: number, decimals: number, precision = 2): bigint {
  const [whole, fraction = "0"] = amount.toFixed(precision).split(".");
  const scale = 10n ** BigInt(decimals);
  return BigInt(whole!) * scale + (BigInt(fraction) * scale) / 10n ** BigInt(precision);
}

/** Whole tokens as atoms at the selected precision. */
export function tokenAtoms(supply: number, decimals: number): bigint {
  return BigInt(supply) * 10n ** BigInt(decimals);
}

/** Keep daily releases for month drafts; finer units release at their own precision. */
export function vestingTerms(cliff: number, duration: number, cliffUnit: VestingUnit = "months", durationUnit: VestingUnit = "months"): VestingTerms {
  const cliffDelayMs = vestingDurationMs(cliff, cliffUnit);
  const durationMs = vestingDurationMs(duration, durationUnit);
  const periodDurationMs = BigInt(Math.min(Number(DAY_MS), VESTING_UNIT_MS[durationUnit], cliff > 0 ? VESTING_UNIT_MS[cliffUnit] : Number(DAY_MS)));
  if (durationMs <= 0n || durationMs > MAX_VESTING_DURATION_MS || cliffDelayMs < 0n || cliffDelayMs > durationMs) {
    throw new RangeError("The vesting schedule is outside the contract's limits.");
  }
  return { cliffDelayMs, periodDurationMs, periods: durationMs / periodDurationMs };
}

function share(row: CreateRecipient): RecipientShare {
  return {
    recipient: {
      destination: row.address.trim().toLowerCase(),
      vestingTerms: row.vest ? vestingTerms(row.cliff, row.duration, row.cliff_unit, row.duration_unit) : null,
    },
    bps: BigInt(row.bps),
  };
}

export type ArgsContext = Readonly<{
  fees: CreateFeePolicy;
  allowlist: CreateAllowlistSummary | null;
  /** The check time for the draft's scheduled start (`IssueContext.nowMs`). */
  nowMs?: number;
  /** The wallet that publishes: the creator's own fee row pays to it. */
  creator: string;
  logoUrl: string | null;
}>;

/**
 * The contract's arguments for a draft with no issues. The creator's fee row
 * goes to `creator` and is left out at 0% (OA-14); every other row is as
 * typed. Throws `RangeError` on a draft that still has issues.
 */
export function presaleArgs(draft: CreateDraft, context: ArgsContext): CreatePresaleArgs {
  if (draftIssues(draft, context).length > 0) throw new RangeError("The draft has issues.");
  const durationMs = BigInt(draft.days) * DAY_MS;
  // R3-42: every raise figure in the draft's own coin.
  const decimals = draftQuote(draft).decimals;
  const atoms = (amount: number) => quoteAtoms(amount, decimals);
  const eligibility: EligibilityPolicy =
    draft.eligibility === "open"
      ? {
          kind: "open",
          walletCap: atoms(draft.wallet_cap),
          maxParticipants: BigInt(draft.max_wallets),
          minCommitment: atoms(draft.min_commitment),
        }
      : { kind: "allowlisted", root: context.allowlist!.root, leafCount: BigInt(context.allowlist!.leaf_count) };
  const uncapped: UncappedPhase | null = !draft.lift
    ? null
    : {
        startsAfterMs: durationMs - BigInt(draft.lift_hours) * HOUR_MS,
        access:
          draft.lift_access === "anyone"
            ? { kind: "anyone", maxParticipants: BigInt(draft.lift_max_wallets), minCommitment: atoms(draft.lift_min) }
            : { kind: "eligible" },
      };
  const hardCap: HardCap | null =
    draft.launch_when_filled
      ? { startsAfterMs: 0n, closesWhenFilled: true }
      : uncapped && draft.lift_hard_cap
        ? { startsAfterMs: uncapped.startsAfterMs, closesWhenFilled: false }
        : null;
  const [tickSpacing] = venueTiers(draft.venue).find(([, fee]) => fee === draft.pool_fee)!;
  const routes: Route[] = draft.fee_recipients
    .filter((row) => !(row.self && row.bps === 0))
    .map((row) => ({
      destination: { kind: "Address", address: row.self ? context.creator.toLowerCase() : row.address.trim().toLowerCase() },
      bps: BigInt(row.bps),
    }));
  if (draft.holders_bps > 0) routes.push({ destination: { kind: "HolderRewards" }, bps: BigInt(draft.holders_bps) });
  return {
    tokenSupply: tokenAtoms(draft.supply, draft.decimals),
    tokenAllocationBps: BigInt(draft.buyers_bps),
    participantVesting: draft.buyer_vesting.vest
      ? vestingTerms(draft.buyer_vesting.cliff, draft.buyer_vesting.duration, draft.buyer_vesting.cliff_unit, draft.buyer_vesting.duration_unit)
      : null,
    liquidityTokenAllocationBps: BigInt(draft.pool_bps),
    recipientAllocations: draft.token_recipients.map(share),
    raiseTarget: quoteAtoms(draft.target, decimals, presaleTargetDecimals(draft.quote_type)),
    raiseAllocations: draft.raise_recipients.map(share),
    durationMs,
    liquidityWindowMs: BigInt(draft.lp_days) * DAY_MS,
    eligibility,
    uncapped,
    hardCap,
    feeSplit: { routes },
    protocolFees: {
      raiseBps: BigInt(context.fees.raise_bps),
      tokenBps: BigInt(context.fees.token_bps),
      lpFeeMemeBps: BigInt(context.fees.lp_fee_meme_bps),
      lpFeeQuoteBps: BigInt(context.fees.lp_fee_quote_bps),
    },
    burnable: draft.burnable,
    venue: draft.venue,
    quoteType: draft.quote_type,
    tickSpacing,
    poolFeeRate: BigInt(draft.pool_fee),
    startMs: BigInt(draft.start_ms ?? 0),
    coin: {
      name: draft.name.trim(),
      symbol: draft.symbol,
      description: draft.tagline.trim(),
      iconUrl: context.logoUrl ?? "",
      decimals: draft.decimals,
    },
  };
}

/** Where a contract refusal shows in the form, and the words for it (OA-13). */
const ABORT_ISSUES: Partial<Record<PresaleAbortError["abort"], Readonly<{ section: CreateSection; path: string; message: string }>>> = {
  EUnseedablePrice: { section: "rsplit", path: "seed_price", message: "The pool's opening price is out of range. Change the target or the pool's share" },
  EInvalidTokenAllocation: { section: "split", path: "split_amounts", message: "A share is too small to get any tokens" },
  EInvalidRaiseAllocation: { section: "rsplit", path: "rsplit_amounts", message: "A share is too small to get any of the raise" },
  EUnreachableRaise: { section: "join", path: "reach", message: "Filling every slot at the minimum must reach the target" },
  EInvalidFeeSplit: { section: "fees", path: "fee_total", message: "Each fee share needs its own wallet" },
};

/** A creator address for checking a draft before anyone signs: any valid one gives the same amounts. */
const PREVIEW_CREATOR = `0x${"c".repeat(64)}`;

/**
 * Everything left to fix: the form's issues, then, once the form is
 * complete, what `blast_presale::new` would still refuse (the SDK's
 * `previewPresaleCreation`, which mirrors its checks in abort order): a seed
 * price the venues cannot pool, or a share that apportions to nothing.
 * `creator` is the publishing wallet when known (a fee recipient repeating
 * it is then caught too).
 */
export function createIssues(draft: CreateDraft, context: IssueContext & Readonly<{ creator?: string | null }>): CreateIssue[] {
  const issues = draftIssues(draft, context);
  if (issues.length > 0) return issues;
  // An allowlist read in the browser has no root until the server has it: the chain's checks wait for it.
  if (draft.eligibility === "allowlist" && !/^[0-9a-f]{64}$/.test(context.allowlist?.root ?? "")) return issues;
  const args = presaleArgs(draft, { ...context, creator: context.creator ?? PREVIEW_CREATOR, logoUrl: null });
  try {
    previewPresaleCreation(args);
  } catch (error) {
    if (!(error instanceof PresaleAbortError)) throw error;
    const issue = ABORT_ISSUES[error.abort] ?? { section: "token", path: "contract", message: presaleAbortMessage(error.abort) ?? "The presale configuration was refused. Review it and retry." };
    return [issue];
  }
  return [];
}

