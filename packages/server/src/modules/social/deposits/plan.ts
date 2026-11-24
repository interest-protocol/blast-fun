import { normalizeSuiAddress } from "@mysten/sui/utils";

import { decodeCctpMessage } from "@blast/core/modules/presale/bridge/cctp-message.ts";
import { CCTP_SOURCE_DOMAINS, SUI_CCTP_DOMAIN, type BridgeTransfer } from "@blast/core/modules/presale/bridge/contracts.ts";
import { FAST_FINALITY_THRESHOLD, STANDARD_FINALITY_THRESHOLD } from "@blast/core/modules/presale/bridge/quote.ts";
import type { BridgeQuoteResponse } from "@blast/core/modules/presale/contracts/web-api.ts";
import type { SocialDepositPlan, SocialDepositSource, SocialDepositTransfer } from "@blast/core/modules/social/contracts/deposits.ts";
import type { SocialTransactionFailure } from "@blast/core/modules/social/contracts/transactions.ts";

/**
 * The deposit's pure rules (OA-25): which route a burn takes and what it
 * signs, and what a registered burn's state means for the attempt in the
 * account's transaction log. The route (`route.ts`) reads the bridge and
 * Circle; everything it decides is here, so each rule is tested once.
 */

/** A non-negative decimal string as an exact fraction `units / scale`. */
function fraction(decimal: string): { units: bigint; scale: bigint } {
  const [whole, part = ""] = decimal.split(".");
  return { units: BigInt(`${whole}${part}`), scale: 10n ** BigInt(part.length) };
}

/**
 * A Standard burn's `maxFee`: `ceil(amount × fee_bps / 10,000)` atoms in
 * integer arithmetic (the presale rail's rule, T-016; the quote carries none
 * for Standard). Circle's Standard fee is usually 0, so this is usually 0.
 */
export function standardMaxFee(amount: bigint, feeBps: string): bigint {
  const fee = fraction(feeBps);
  const numerator = amount * fee.units;
  const denominator = fee.scale * 10_000n;
  return (numerator + denominator - 1n) / denominator;
}

/**
 * The burn for `amount` USDC atoms to the Blast wallet, from the bridge's
 * quote: Fast when Circle lists a Fast route, the global Fast allowance
 * covers the amount and its fee leaves something to mint; otherwise
 * Standard. Null when even Standard's fee would take the whole amount (the
 * token messenger refuses `maxFee >= amount`).
 */
export function depositPlan(quote: BridgeQuoteResponse, amount: bigint, blastWallet: string): SocialDepositPlan | null {
  const common = {
    destination_domain: SUI_CCTP_DOMAIN,
    mint_recipient: normalizeSuiAddress(blastWallet),
    destination_caller: quote.destination_caller,
    hook_data: quote.hook_data,
  } as const;
  const fast = quote.fast;
  if (fast && fast.allowance_ok && BigInt(fast.max_fee) < amount) {
    return {
      speed: "fast",
      eta_seconds: fast.eta_seconds,
      fee_bps: fast.fee_bps,
      max_fee: fast.max_fee,
      min_finality_threshold: FAST_FINALITY_THRESHOLD,
      ...common,
    };
  }
  const maxFee = standardMaxFee(amount, quote.standard.fee_bps);
  if (maxFee >= amount) return null;
  return {
    speed: "standard",
    eta_seconds: quote.standard.eta_seconds,
    fee_bps: quote.standard.fee_bps,
    max_fee: maxFee.toString(),
    min_finality_threshold: STANDARD_FINALITY_THRESHOLD,
    ...common,
  };
}

/** `next_poll_at` from here on means the relayer parked the transfer (`BRIDGE_PARKED_UNTIL` is 9999-12-31). */
const PARKED_FROM_MS = Date.parse("9999-01-01T00:00:00Z");

/** What the attempt is, given the bridge's transfer for its burn. */
export type DepositVerdict =
  | Readonly<{ state: "open" }>
  | Readonly<{ state: "confirmed"; digest: string; settledAtMs: number }>
  | Readonly<{ state: "failed"; failureCode: Extract<SocialTransactionFailure, "mismatch" | "expired">; settledAtMs: number | null }>;

/** Whether an attested burn is this attempt's: from its source, to Sui, minting exactly its amount to the Blast wallet. */
function attestedIsThis(message: string, expected: DepositExpectation): boolean {
  try {
    const decoded = decodeCctpMessage(message);
    const body = decoded.body;
    return (
      body !== null &&
      decoded.sourceDomain === CCTP_SOURCE_DOMAINS[expected.source] &&
      decoded.destinationDomain === SUI_CCTP_DOMAIN &&
      body.mintRecipient === normalizeSuiAddress(expected.blastWallet) &&
      body.amount === expected.amount
    );
  } catch {
    return false;
  }
}

export type DepositExpectation = Readonly<{ source: SocialDepositSource; blastWallet: string; amount: bigint }>;

/**
 * The attempt's outcome from the bridge's transfer. The registration's own
 * address and amount are unauthenticated hints, so only the attested
 * message decides: `confirmed` once minted, when the burn paid exactly this
 * amount to this Blast wallet from this source (the Sui mint's digest and
 * time); `mismatch` for a burn the bridge refused (`invalid_burn`) or one
 * attested for anything else; `expired` once the relayer parked a burn
 * Circle never saw (24 h; nothing more will happen unless it is registered
 * again by hand). Everything else is still in flight.
 */
export function depositVerdict(transfer: BridgeTransfer, expected: DepositExpectation): DepositVerdict {
  if (transfer.message !== null && !attestedIsThis(transfer.message, expected)) {
    return { state: "failed", failureCode: "mismatch", settledAtMs: (transfer.mintedAt ?? transfer.attestedAt)?.getTime() ?? null };
  }
  if (transfer.status === "minted" && transfer.message !== null && transfer.suiDigest !== null && transfer.mintedAt !== null) {
    return { state: "confirmed", digest: transfer.suiDigest, settledAtMs: transfer.mintedAt.getTime() };
  }
  if (transfer.status === "failed" && transfer.error === "invalid_burn") {
    return { state: "failed", failureCode: "mismatch", settledAtMs: transfer.failedAt?.getTime() ?? null };
  }
  if (
    transfer.status === "failed" &&
    transfer.error === "attestation_timeout" &&
    transfer.attestedAt === null &&
    transfer.nextPollAt.getTime() >= PARKED_FROM_MS
  ) {
    return { state: "failed", failureCode: "expired", settledAtMs: null };
  }
  return { state: "open" };
}

/** Where a V2 burn body's `feeExecuted` (uint256) starts: version, burn token, recipient, amount, sender, max fee. */
const V2_FEE_EXECUTED_AT = 4 + 32 * 5;
/** Where a V2 message's body starts. */
const V2_BODY_AT = 148;

/**
 * What an attested burn mints to its recipient, in atoms: the burned amount
 * less the fee Circle executed (V2's `feeExecuted`, which Circle fills in
 * when it attests; V1 has no fee). Null for bytes that are not a burn.
 */
export function mintedAmount(message: string): bigint | null {
  try {
    const decoded = decodeCctpMessage(message);
    if (decoded.body === null) return null;
    if (decoded.version === 0) return decoded.body.amount;
    const start = 2 + (V2_BODY_AT + V2_FEE_EXECUTED_AT) * 2;
    const fee = BigInt(`0x${message.slice(start, start + 64)}`);
    return fee <= decoded.body.amount ? decoded.body.amount - fee : null;
  } catch {
    return null;
  }
}

/** The bridge's view as the client sees it: fixed labels only, never Circle's own delay text. */
export function depositTransferView(transfer: BridgeTransfer): SocialDepositTransfer {
  const error =
    transfer.error === null
      ? null
      : transfer.error === "invalid_burn" || transfer.error === "attestation_timeout"
        ? transfer.error
        : "delayed";
  const minted = transfer.message === null ? null : mintedAmount(transfer.message);
  return { id: transfer.id, status: transfer.status, error, minted_amount: minted === null ? null : minted.toString() };
}
