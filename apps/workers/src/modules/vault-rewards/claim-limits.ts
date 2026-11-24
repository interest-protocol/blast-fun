// Sui mainnet protocol limits. Claims use one command per leaf.
export const MAX_REWARD_CLAIMS_PER_PTB = 1023;
export const MAX_SUI_TRANSACTION_BYTES = 128 * 1024;
export const ED25519_SIGNED_ENVELOPE_BYTES = 103;
export const REWARD_CLAIM_GAS_LIMIT_MIST = 1_000_000_000n;
