/**
 * The Cetus aggregator router functions whose arguments the sponsor policy
 * reads beyond the derived lists (Cetus SDK `newSwapContextV3` and
 * `confirmSwapV3`). The derivation asserts this layout on every fixture build,
 * so a Cetus change fails the drift test instead of loosening the policy.
 */
export const SWAP_CONTEXT = {
  function: "router::new_swap_context_v3",
  /** `input_coin` supplies the route with its source coin. */
  inputCoin: 5,
  /** `fee_rate: u32`, parts per million of the swap output. */
  feeRate: 6,
  /** `fee_recipient: address`, paid the fee. */
  feeRecipient: 7,
} as const;

/** `router::confirm_swap_v3<Target>`: type argument 0 is the swap's output coin. */
export const SWAP_OUTPUT = "router::confirm_swap_v3";
