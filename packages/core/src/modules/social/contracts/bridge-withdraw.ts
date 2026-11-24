import { z } from "zod";

/**
 * Withdraw to another chain (the coins sheet's Withdraw USDC, "To another
 * chain"; owner decision 2026-10-06: the bridge is CCTP V2 and the sheet
 * deposits and withdraws across chains). USDC in the reader's Blast wallet on
 * Sui is burned with Circle's CCTP V2 and minted to the reader's address on
 * Base, Arbitrum, Ethereum or Solana by Circle's Forwarding Service: Circle
 * submits the destination's mint, so no wallet on that chain is needed.
 *
 * Three routes, each signed in with an account, primary, `private, no-store`:
 *
 * - `GET /api/social/me/bridge-withdrawals/quote` (bucket `social_read`):
 *   per destination, whether it is live (the bridge's activation record says
 *   so: `not_live`), whether Circle forwards there (`not_forwarded`), and
 *   Circle's fees now (`circle_unavailable` when Circle cannot be asked);
 *   who pays the Sui network fee (Blast, for an embedded Blast wallet and a
 *   wallet session alike; owner ruling 2026-11-20 reversed OA-17).
 * - `POST /api/social/me/bridge-withdrawals` (bucket `social_bridge_withdraw`):
 *   builds the burn for the Blast wallet to sign — exactly `amount` USDC
 *   burned on Sui for `recipient` on `destination`, at most `max_fee` kept by
 *   Circle — dry-runs it, has Blast's gas pool sponsor it for every caller
 *   (the presale sponsor's in-process `bridge_withdraw` intent), and
 *   records it (and its row in the account's transaction log, kind
 *   `withdraw`) before anything is signed. Idempotent on `idempotency_key`.
 * - `POST /api/social/me/bridge-withdrawals/{withdrawal_id}/settle` (bucket
 *   `social_transfer`): reads the burn from Sui by the digest the server
 *   computed from the bytes it built (`burned` once it executed as this
 *   withdrawal), then Circle's message for it (`delivered` once Circle
 *   reports its mint on the destination, with that transaction's hash).
 *
 * Amounts are USDC atoms (6 decimals), exact integers as decimal strings.
 *
 * Refusals (beyond the kit's): `invalid_recipient` (422, not an address on
 * that chain), `invalid_amount` (422, the fee would take the whole amount),
 * `blast_wallet_missing` (409), `bridge_withdraw_conflict` (409, the key was
 * used for another withdrawal; the recorded one is attached as
 * `withdrawal`), `bridge_fee_changed` (409, Circle's fee is above the
 * `max_fee` sent; today's is attached as `max_fee`), and
 * `bridge_unavailable` (503 with `Retry-After`: the destination is not live
 * or Circle cannot be asked now).
 */

export const SOCIAL_BRIDGE_WITHDRAW_QUOTE_ROUTE = "GET /api/social/me/bridge-withdrawals/quote";
export const SOCIAL_BRIDGE_WITHDRAW_ROUTE = "POST /api/social/me/bridge-withdrawals";
export const SOCIAL_BRIDGE_WITHDRAW_SETTLE_ROUTE = "POST /api/social/me/bridge-withdrawals/{withdrawal_id}/settle";

export const SOCIAL_BRIDGE_WITHDRAW_QUOTE_PATH = "/api/social/me/bridge-withdrawals/quote";
export const SOCIAL_BRIDGE_WITHDRAW_PATH = "/api/social/me/bridge-withdrawals";

export function socialBridgeWithdrawSettlePath(withdrawalId: string): string {
  return `${SOCIAL_BRIDGE_WITHDRAW_PATH}/${encodeURIComponent(withdrawalId)}/settle`;
}

/** Where a withdrawal can go, in the sheet's order (the deposit side's chains). */
export const BRIDGE_WITHDRAW_DESTINATIONS = ["base", "arbitrum", "ethereum", "solana"] as const;
export type BridgeWithdrawDestination = (typeof BRIDGE_WITHDRAW_DESTINATIONS)[number];

export const bridgeWithdrawDestinationSchema = z.enum(BRIDGE_WITHDRAW_DESTINATIONS);

export function isBridgeWithdrawDestination(value: unknown): value is BridgeWithdrawDestination {
  return bridgeWithdrawDestinationSchema.safeParse(value).success;
}

/**
 * Why a destination is not offered now:
 *
 * - `not_live`: the bridge's activation record does not list a passing
 *   withdrawal to it (or the bridge is off).
 * - `not_forwarded`: Circle's fee list for the route carries no Forwarding
 *   Service fee, so Circle would not mint there for us.
 * - `circle_unavailable`: Circle's API could not be asked just now.
 */
export const BRIDGE_WITHDRAW_UNAVAILABLE_REASONS = ["not_live", "not_forwarded", "circle_unavailable"] as const;
export type BridgeWithdrawUnavailableReason = (typeof BRIDGE_WITHDRAW_UNAVAILABLE_REASONS)[number];

export type SocialBridgeWithdrawOption = SocialBridgeWithdrawQuote["destinations"][number];

export type SocialBridgeNetworkFee = SocialBridgeWithdrawQuote["network_fee"];

export type SocialBridgeWithdrawQuote = Readonly<z.infer<typeof socialBridgeWithdrawQuoteSchema>>;

/**
 * The most Circle may keep of `amount` atoms (the burn's `max_fee`):
 * `ceil(amount × fee_bps × 1.25 / 10000)` (the deposit quote's protocol-fee
 * rule, `bridgeMaxFee`) plus the Forwarding Service's fee. Exact, in atoms.
 */
export function bridgeWithdrawMaxFee(amount: bigint, feeBps: string, forwardFee: bigint): bigint {
  const [whole, part = ""] = feeBps.split(".");
  const units = BigInt(`${whole}${part}`);
  const scale = 10n ** BigInt(part.length);
  const numerator = amount * units * 125n;
  const denominator = scale * 1_000_000n;
  return (numerator + denominator - 1n) / denominator + forwardFee;
}

export type SocialBridgeWithdrawRequest = Readonly<z.infer<typeof socialBridgeWithdrawRequestSchema>>;

/**
 * A withdrawal's life: `built` (recorded, the bytes waiting for a
 * signature), `burned` (executed on Sui as this withdrawal: Circle attests
 * and mints from here), `delivered` (Circle reported its mint on the
 * destination), `failed` (`failure_code`).
 */
export const SOCIAL_BRIDGE_WITHDRAW_STATUSES = ["built", "burned", "delivered", "failed"] as const;
export type SocialBridgeWithdrawStatus = (typeof SOCIAL_BRIDGE_WITHDRAW_STATUSES)[number];

/**
 * Why a withdrawal failed, each before Circle could mint it (a burned one
 * never fails: Circle mints it):
 *
 * - `insufficient_balance`: the Blast wallet held less USDC than `amount`.
 * - `dry_run_failed`: the burn did not execute in its dry run on Sui.
 * - `sponsor_refused`: a shared sponsor budget or reservation slot definitively refused this withdrawal.
 * - `execution_failed`: it executed on Sui and aborted (nothing burned).
 * - `mismatch`: the digest executed as something else.
 * - `expired`: never-returned sponsor bytes expired while atomically proven unsubmitted; returned bytes remain reconcilable.
 */
export const SOCIAL_BRIDGE_WITHDRAW_FAILURES = ["insufficient_balance", "dry_run_failed", "sponsor_refused", "execution_failed", "mismatch", "expired"] as const;
export type SocialBridgeWithdrawFailure = (typeof SOCIAL_BRIDGE_WITHDRAW_FAILURES)[number];

export type SocialBridgeWithdrawal = Readonly<z.infer<typeof socialBridgeWithdrawalSchema>>;

// Published wire contracts. Semantic request checks keep their ordered route refusals.
export const socialBridgeWithdrawRequestSchema = z.strictObject({
  idempotency_key: z.string().regex(new RegExp("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", "u")),
  destination: bridgeWithdrawDestinationSchema,
  recipient: z.string().regex(new RegExp("^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$", "u")).refine((value) => [...value].length >= 32).refine((value) => [...value].length <= 44).meta({"minLength": 32, "maxLength": 44}),
  amount: z.string().regex(new RegExp("^[1-9][0-9]{0,19}$", "u")),
  max_fee: z.string().regex(new RegExp("^(0|[1-9][0-9]{0,19})$", "u")),
}).meta({"title": "Withdraw to another chain", "description": "POST /api/social/me/bridge-withdrawals: the client's key for this withdrawal (a UUID v4, resent on every retry), where it goes and to whom, the USDC atoms burned on Sui, and the most Circle may keep (the fee the sheet showed: at least today's, below the amount)."});

export const socialBridgeWithdrawalSchema = z.strictObject({
  withdrawal_id: z.string().regex(new RegExp("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", "u")),
  status: z.enum(SOCIAL_BRIDGE_WITHDRAW_STATUSES),
  destination: bridgeWithdrawDestinationSchema,
  recipient: z.string().regex(new RegExp("^(0x[0-9a-f]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$", "u")),
  amount: z.string().regex(new RegExp("^[1-9][0-9]{0,19}$", "u")),
  max_fee: z.string().regex(new RegExp("^(0|[1-9][0-9]{0,19})$", "u")),
  receive: z.string().regex(new RegExp("^[1-9][0-9]{0,19}$", "u")),
  network_fee: z.strictObject({
    payer: z.enum(["blast", "wallet"]),
    label: z.enum(["Paid by Blast", "Paid from your SUI"]),
  }).nullable(),
  reservation_id: z.string().regex(new RegExp("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", "u")).nullable(),
  transaction_bytes: z.string().regex(new RegExp("^[A-Za-z0-9+/]+={0,2}$", "u")).nullable(),
  digest: z.string().regex(new RegExp("^[1-9A-HJ-NP-Za-km-z]{32,44}$", "u")).nullable(),
  expires_at_ms: z.number().min(0).refine(Number.isInteger).meta({"type": "integer"}).nullable(),
  failure_code: z.enum(SOCIAL_BRIDGE_WITHDRAW_FAILURES).nullable(),
  destination_tx_hash: z.string().regex(new RegExp("^(0x[0-9a-f]{64}|[1-9A-HJ-NP-Za-km-z]{64,88})$", "u")).nullable(),
  created_at_ms: z.number().min(0).refine(Number.isInteger).meta({"type": "integer"}),
  burned_at_ms: z.number().min(0).refine(Number.isInteger).meta({"type": "integer"}).nullable(),
  delivered_at_ms: z.number().min(0).refine(Number.isInteger).meta({"type": "integer"}).nullable(),
}).meta({"title": "A withdrawal to another chain", "description": "POST /api/social/me/bridge-withdrawals (201 built or refused, 200 a replay) and POST /api/social/me/bridge-withdrawals/{withdrawal_id}/settle (200): the withdrawal, the bytes its Blast wallet signs while built, and how far it got: burned on Sui, delivered on the destination by Circle, or failed (private, no-store)."});

export const socialBridgeWithdrawQuoteSchema = z.strictObject({
  destinations: z.array(z.strictObject({
    destination: bridgeWithdrawDestinationSchema,
    available: z.boolean(),
    unavailable_reason: z.enum(["not_live", "not_forwarded", "circle_unavailable"]).nullable(),
    fee_bps: z.string().regex(new RegExp("^(0|[1-9][0-9]*)(\\.[0-9]+)?$", "u")).nullable(),
    forward_fee: z.string().regex(new RegExp("^(0|[1-9][0-9]{0,19})$", "u")).nullable(),
  })).min(4).max(4).readonly(),
  network_fee: z.strictObject({
    payer: z.enum(["blast", "wallet"]),
    label: z.enum(["Paid by Blast", "Paid from your SUI"]),
  }),
  as_of_ms: z.number().min(0).refine(Number.isInteger).meta({"type": "integer"}),
}).meta({"title": "Withdraw to another chain: the offer", "description": "GET /api/social/me/bridge-withdrawals/quote: per destination (Base, Arbitrum, Ethereum, Solana, in that order) whether a withdrawal can go there now and Circle's fees for it, and who pays the Sui network fee (private, no-store)."});
