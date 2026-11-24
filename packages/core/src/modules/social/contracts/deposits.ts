import { z } from "zod";
import { positiveBridgeAtomsSchema } from "@blast/core/modules/presale/contracts/bridge-transfer-request.ts";

import type { SocialTransactionFailure } from "@blast/core/modules/social/contracts/transactions.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

/**
 * The deposit transaction (OA-25's second new ticket): USDC sent from
 * another chain into the account's Blast wallet on Sui, through Circle's
 * CCTP V2 — the coins sheet's "Deposit USDC → From another chain".
 *
 * The user signs exactly one thing, on the source chain, in their own
 * wallet: the USDC burn (`depositForBurn`, or `depositForBurnWithHook` when
 * Circle's Forwarding Service mints), with an exact-amount approval first on
 * an EVM chain whose allowance is short. The Sui side is never theirs to
 * sign: the presale bridge's relayer receives and mints (`blast`
 * forwarding; Blast pays its gas), or Circle's forwarder does (`circle`).
 * So no Sui fee is the user's whatever their Blast wallet is (OA-17 does not
 * arise); the source chain's gas is their own wallet's.
 *
 * The bridge is the presale backend's (`modules/presale/bridge`, T-020/T-021):
 * its activation record decides whether it is on, Circle's fees decide the
 * route, and its transfer registry is what the relayer tracks. A deposit is
 * one more registered transfer whose mint recipient is the Blast wallet.
 */

/** `GET /api/social/me/deposits`: whether a deposit from another chain can start now (the bridge's activation record). */
export const SOCIAL_DEPOSIT_BRIDGE_ROUTE = "GET /api/social/me/deposits";
export const SOCIAL_DEPOSITS_PATH = "/api/social/me/deposits";

/**
 * `PUT /api/social/me/deposits/{request_id}`: signed in with an account,
 * bucket `social_deposit`, primary, `private, no-store`. The client picks
 * `request_id` (a UUID v4) per attempt:
 *
 * 1. **Record** (`source`, `amount` in USDC atoms) once the source wallet is
 *    connected and holds the amount, **before it is asked to sign**: the
 *    route checks the bridge is on (`409 deposit_unavailable` otherwise),
 *    reads Circle's fees, builds the burn plan for the caller's Blast wallet
 *    (`plan`), and logs the attempt in the account's transaction log (R3-27)
 *    as a `submitted` deposit of that many USDC.
 * 2. **Source hash** (the same body plus `tx_hash`), as soon as the source
 *    wallet returned it: the burn is registered with the bridge (idempotent
 *    on the source and hash; never re-registered once known, so a parked
 *    transfer is not re-armed by a reader), and the attempt is settled from
 *    what the bridge knows — `confirmed` with the Sui mint's digest once the
 *    attested burn minted this many USDC to the Blast wallet, `failed` /
 *    `mismatch` for a burn the bridge refused or one that paid anything
 *    else, `failed` / `expired` once the bridge stopped looking for a burn
 *    Circle never saw. `202` while it is in flight: send it again later.
 * 3. **Failure** (the same body plus `failure`), when nothing was burned:
 *    the wallet declined (`rejected`), the wallet or chain refused to send it
 *    (`dry_run_failed`), or the plan went unused (`expired`). Only for an
 *    attempt the bridge never heard of.
 *
 * Answers: `201` recorded now; `200` already recorded or settled; `202` in
 * flight. Refusals besides the kit's: `400 invalid_parameter` (the id),
 * `400 invalid_request` (the body, or a hash not in its source's format),
 * `404 not_found` (another account's id, or a hash or failure for an
 * attempt never recorded), `409 blast_wallet_missing`, `409
 * deposit_unavailable` (the bridge is off, or Circle lists no route from
 * that source), `409 deposit_conflict` (the id was recorded for another
 * amount, a mint another attempt holds, or a failure after a burn), `422
 * invalid_amount` (too small to cover the route's fee), `503
 * service_unavailable` (Circle or the database).
 */
export const SOCIAL_DEPOSIT_ROUTE = "PUT /api/social/me/deposits/{request_id}";

export function socialDepositPath(requestId: string): string {
  return `${SOCIAL_DEPOSITS_PATH}/${encodeURIComponent(requestId)}`;
}

/** The source chains, in the gate's order (`CCTP_CHAINS`); each is a CCTP V2 domain that burns to Sui (domain 8). */
export const SOCIAL_DEPOSIT_SOURCES = ["base", "arbitrum", "ethereum", "solana"] as const;
export type SocialDepositSource = (typeof SOCIAL_DEPOSIT_SOURCES)[number];

export const socialDepositSourceSchema = z.enum(SOCIAL_DEPOSIT_SOURCES);

export function isSocialDepositSource(value: unknown): value is SocialDepositSource {
  return socialDepositSourceSchema.safeParse(value).success;
}

/** What the client may report about an attempt that burned nothing. */
export const SOCIAL_DEPOSIT_CLIENT_FAILURES = ["rejected", "dry_run_failed", "expired"] as const satisfies readonly SocialTransactionFailure[];
export type SocialDepositClientFailure = (typeof SOCIAL_DEPOSIT_CLIENT_FAILURES)[number];

export type SocialDepositRequest = Readonly<z.infer<typeof socialDepositRequestSchema>>;

/**
 * The burn to sign, built by the server for the caller's Blast wallet from
 * the bridge's activation record and Circle's fees. Fast when Circle lists a
 * Fast route and the global Fast allowance covers the amount, else Standard
 * (the presale rail's rule, T-016). The source chain's USDC and token
 * messenger are the client's own constants, never the server's.
 */
export type SocialDepositPlan = NonNullable<SocialDeposit["plan"]>;

/** What the bridge knows about the registered burn. */
export type SocialDepositTransfer = NonNullable<SocialDeposit["transfer"]>;

/** The transaction-log model retains its full failure vocabulary; the published wire schema is narrower. */
export type SocialDeposit = Readonly<Omit<z.infer<typeof socialDepositSchema>, "failure_code"> & {
  failure_code: SocialTransactionFailure | null;
}>;

/** `GET /api/social/me/deposits`: whether the bridge is on now. */
export type SocialDepositBridge = Readonly<z.infer<typeof socialDepositBridgeSchema>>;

// Published wire contracts. Semantic request checks keep their ordered route refusals.
export const socialDepositRequestSchema = z.strictObject({
  source: socialDepositSourceSchema,
  amount: z.string().regex(new RegExp("^[1-9][0-9]{0,19}$", "u")),
  tx_hash: z.string().regex(new RegExp("^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{64,88})$", "u")).optional(),
  failure: z.enum(["rejected", "dry_run_failed", "expired"]).optional(),
}).meta({"title": "Record, then settle, a deposit from another chain", "description": "PUT /api/social/me/deposits/{request_id} (OA-25): the source chain and the USDC atoms to burn there; then the same body with the burn's hash, or with why nothing was burned. Never both."}).refine((body) => body.tx_hash === undefined || body.failure === undefined).meta({ not: { required: ["tx_hash", "failure"], properties: { tx_hash: true, failure: true } } });

export const socialDepositSchema = z.strictObject({
  request_id: z.string().regex(new RegExp("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", "u")),
  source: socialDepositSourceSchema,
  amount: z.string().regex(new RegExp("^[1-9][0-9]{0,19}$", "u")),
  state: z.enum(["submitted", "confirmed", "failed"]),
  digest: z.string().regex(new RegExp("^[1-9A-HJ-NP-Za-km-z]{32,44}$", "u")).nullable(),
  failure_code: z.enum(["mismatch", "dry_run_failed", "rejected", "expired"]).nullable(),
  tx_hash: z.string().regex(new RegExp("^(0x[0-9a-f]{64}|[1-9A-HJ-NP-Za-km-z]{64,88})$", "u")).nullable(),
  transfer: z.strictObject({
    id: z.string().regex(new RegExp("^bt_[0-9a-f]{32}$", "u")),
    status: z.enum(["sent", "attested", "minted", "failed"]),
    error: z.enum(["invalid_burn", "attestation_timeout", "delayed"]).nullable(),
    minted_amount: z.string().regex(new RegExp("^(0|[1-9][0-9]{0,19})$", "u")).nullable(),
  }).nullable(),
  plan: z.strictObject({
    speed: z.enum(["fast", "standard"]),
    eta_seconds: z.number().min(0).refine(Number.isInteger).meta({"type": "integer"}),
    fee_bps: z.string().regex(new RegExp("^(0|[1-9][0-9]*)(\\.[0-9]+)?$", "u")),
    max_fee: z.string().regex(new RegExp("^(0|[1-9][0-9]{0,19})$", "u")),
    min_finality_threshold: z.literal([1000, 2000]),
    destination_domain: z.literal(8),
    mint_recipient: z.string().regex(SUI_OBJECT_ID_PATTERN),
    destination_caller: z.string().regex(SUI_OBJECT_ID_PATTERN),
    hook_data: z.string().regex(new RegExp("^0x([0-9a-f]{2})+$", "u")).refine((value) => [...value].length <= 2050).nullable().meta({"maxLength": 2050}),
  }).nullable(),
  created_at_ms: z.number().min(0).refine(Number.isInteger).meta({"type": "integer"}),
  settled_at_ms: z.number().min(0).refine(Number.isInteger).meta({"type": "integer"}).nullable(),
}).meta({"title": "A deposit from another chain", "description": "PUT /api/social/me/deposits/{request_id} (OA-25): the attempt as the account's transaction log holds it, the burn to sign while it is submitted and no burn was reported, and the bridge's view of the burn this answer saw."});

export const socialDepositBridgeSchema = z.strictObject({
  available: z.boolean(),
}).meta({"title": "Whether a deposit from another chain can start", "description": "GET /api/social/me/deposits (OA-25): true while the CCTP bridge's latest activation record is complete for this deployment."});

/** The server envelope intentionally leaves source-specific hash normalization to its ordered parser. */
export const socialDepositSubmissionSchema = socialDepositRequestSchema.safeExtend({
  amount: positiveBridgeAtomsSchema,
  tx_hash: z.string().optional(),
});
