import type { BridgeQuoteResponse } from "../contracts/web-api.ts";
import type { CircleFee } from "./circle.ts";
import { SUI_CCTP_DOMAIN, type BridgeActivation, type BridgeSource } from "./contracts.ts";

/** Circle's finality thresholds: Fast and Standard. */
export const FAST_FINALITY_THRESHOLD = 1000;
export const STANDARD_FINALITY_THRESHOLD = 2000;
/** The Sui mint after the attestation. */
export const SUI_MINT_SECONDS = 10;

export type BridgeEtaSeconds = Readonly<{
  fast: Readonly<Record<BridgeSource, number>>;
  standard: Readonly<Record<BridgeSource, number>>;
}>;

/** Source finality (Fast: attestation; Standard: hard finality) plus the Sui mint. */
export const DEFAULT_BRIDGE_ETA_SECONDS: BridgeEtaSeconds = Object.freeze({
  fast: Object.freeze({
    ethereum: 20 + SUI_MINT_SECONDS,
    arbitrum: 8 + SUI_MINT_SECONDS,
    base: 8 + SUI_MINT_SECONDS,
    solana: 8 + SUI_MINT_SECONDS,
  }),
  standard: Object.freeze({
    ethereum: 1_140 + SUI_MINT_SECONDS,
    arbitrum: 1_140 + SUI_MINT_SECONDS,
    base: 1_140 + SUI_MINT_SECONDS,
    solana: 25 + SUI_MINT_SECONDS,
  }),
});

/** A non-negative decimal string as an exact fraction `units / scale`. */
function fraction(decimal: string): { units: bigint; scale: bigint } {
  const [whole, part = ""] = decimal.split(".");
  return { units: BigInt(`${whole}${part}`), scale: 10n ** BigInt(part.length) };
}

/** `ceil(amount × fee_bps × 1.25 / 10000)` atoms, exactly: 1.25 / 10000 = 125 / 1,000,000. */
export function bridgeMaxFee(amount: bigint, feeBps: string): bigint {
  const fee = fraction(feeBps);
  const numerator = amount * fee.units * 125n;
  const denominator = fee.scale * 1_000_000n;
  return (numerator + denominator - 1n) / denominator;
}

/** `amount ≤ allowance × 10^6`: the allowance is in USDC, the amount in atoms. */
export function withinFastAllowance(amount: bigint, allowanceUsdc: string): boolean {
  const allowance = fraction(allowanceUsdc);
  return amount * allowance.scale <= allowance.units * 1_000_000n;
}

/**
 * The published quote for `amount` USDC atoms from `source` to Sui. The fee
 * list must have a Standard (2000) entry; without a Fast (1000) entry the
 * route has no Fast leg (`fast: null`). Forwarding, the destination caller
 * and the hook come from the activation record.
 */
export function bridgeQuote(input: Readonly<{
  source: BridgeSource;
  amount: bigint;
  fees: readonly CircleFee[];
  allowanceUsdc: string;
  activation: Extract<BridgeActivation, { active: true }>;
  eta?: BridgeEtaSeconds;
}>): BridgeQuoteResponse | null {
  const eta = input.eta ?? DEFAULT_BRIDGE_ETA_SECONDS;
  const fee = (threshold: number) => input.fees.find((entry) => entry.finalityThreshold === threshold)?.minimumFeeBps;
  const fast = fee(FAST_FINALITY_THRESHOLD);
  const standard = fee(STANDARD_FINALITY_THRESHOLD);
  if (standard === undefined) return null;
  return {
    fast: fast === undefined
      ? null
      : {
        eta_seconds: eta.fast[input.source],
        fee_bps: fast,
        max_fee: `${bridgeMaxFee(input.amount, fast)}`,
        allowance_ok: withinFastAllowance(input.amount, input.allowanceUsdc),
      },
    standard: { eta_seconds: eta.standard[input.source], fee_bps: standard },
    destination_domain: SUI_CCTP_DOMAIN,
    forwarding: input.activation.forwarding,
    destination_caller: input.activation.destinationCaller,
    hook_data: input.activation.hookData,
  };
}
