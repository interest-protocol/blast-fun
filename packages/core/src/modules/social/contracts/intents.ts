import { z } from "zod";
import { COIN_TYPE, SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

/**
 * Intents (T-024): a member's declaration, made while they still hold the
 * signed transaction, of why they are in and which post brought them. The
 * commit dialog registers one after the digest is known and **before** execute,
 * so the social layer can credit the post and attach the why the moment the
 * indexer shows the transaction (T-026 resolves it).
 *
 * `POST /api/social/intents { action, presale_id, tx_digest, source_entry_id?,
 * why?, quote_type?, quote_amount?, usd_value? }`: account required, bucket
 * `social_intent` (60 per minute per account), written on the primary.
 *
 * **It is also the commit's transaction-log write (R3-27).** The first
 * registration of a digest logs the account's commit in `social_transactions`
 * (key `commit:<digest>`, `submitted`, with the digest), in the same
 * transaction as the intent: the coin the commitment is counted in, its atoms
 * and its dollar value at submission, as the dialog built them. They are the
 * account's own record of what it sent, shown only to that account; the chain
 * stays the authority, and the social worker settles the row from it (T-026,
 * migration 0085). Because of this the dialog registers **every** commit,
 * with or without a why or a source item.
 *
 * - `201 { status: "recorded", why }` the first time this digest is seen.
 *   `why` is `null` when none was sent, `"accepted"` when it was stored, and
 *   otherwise the published code the shared `validateWhy` (plus the blocked
 *   terms) answered: `why_empty`, `why_too_long`, `why_invalid`,
 *   `why_has_link` or `blocked_term`. **A failed why is not stored and the
 *   intent is still recorded** (AC-081): the transaction is already signed, so
 *   refusing the registration would lose the attribution over a typo.
 * - `200 { status: "duplicate", why: null }` when this account already
 *   registered this digest. Nothing is written again, so a retry after a
 *   timeout is safe.
 * - `409 digest_taken` when **another** account registered this digest
 *   (AC-095). One digest has one sender, and the first registration stands.
 * - `400 invalid_parameter` for a malformed `presale_id`, `tx_digest` or
 *   `source_entry_id`; `400 invalid_request` for a body that is not exactly
 *   this shape (schema `intent-request`, closed) — which includes
 *   `action: "buy"` and `action: "sell"`, reserved for the swap feature;
 *   `413 body_too_large` over 4 KiB.
 *
 * `source_entry_id` is stored **only when the entry is visible at
 * registration** (`isVisible`), and as `null` otherwise. Attribution relies on
 * this: a post nobody can see never credits anybody, and the check happens
 * once, here, rather than at every later read.
 *
 * The why's text never appears in a log line, a metric or an error — not on
 * this route, not in a validation failure (AC-130). The response carries only
 * the code.
 *
 * Registration is **never allowed to block the transaction**: the caller gives
 * up after `INTENT_REGISTER_TIMEOUT_MS` and executes anyway (AC-096).
 */
export const SOCIAL_INTENT_ROUTE = "POST /api/social/intents";

/** The route's path. */
export const SOCIAL_INTENTS_PATH = "/api/social/intents";

/**
 * The actions an intent can declare. Only `commit` is accepted today; `buy`
 * and `sell` are the swap feature's and are refused with `invalid_request`
 * until it exists. The column's own CHECK already allows all three, so the
 * swap ticket adds its code and no migration.
 */
export const SOCIAL_INTENT_ACTIONS = ["commit", "buy", "sell"] as const;
export type SocialIntentAction = (typeof SOCIAL_INTENT_ACTIONS)[number];

/** The actions this route accepts now. */
export const SOCIAL_INTENT_ACTIONS_ACCEPTED = ["commit"] as const;
export type SocialIntentActionAccepted = (typeof SOCIAL_INTENT_ACTIONS_ACCEPTED)[number];

/** A Sui transaction digest, base58, as the fullnode and the sponsor route write it. */
export const SOCIAL_TX_DIGEST_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** JSON Schema: `schemas/intent-request.schema.json`. */
export type SocialIntentRequest = Readonly<z.infer<typeof socialIntentRequestSchema>>;

/** Atoms of a coin: a u64 as a decimal string. */
export const SOCIAL_ATOMS_PATTERN = /^(0|[1-9][0-9]{0,19})$/;
/** The largest u64, which an atoms amount may not exceed. */
export const SOCIAL_ATOMS_MAX = 18_446_744_073_709_551_615n;
/** Dollars with at most two decimals. */
export const SOCIAL_USD_PATTERN = /^(0|[1-9][0-9]{0,17})(\.[0-9]{1,2})?$/;

/**
 * What became of the why that came with an intent: `accepted`, or the
 * published code that refused it. Every refusal here is one of the whys'
 * own codes (`SOCIAL_ERRORS`), so a client that already renders a why's
 * refusal renders this one with the same copy. `contracts/` depends on
 * nothing outside itself, so the shared `WhyTextRefusal` union is checked
 * against this list in the route instead of imported here.
 */
export const SOCIAL_INTENT_WHY_RESULTS = [
  "accepted",
  "why_empty",
  "why_too_long",
  "why_invalid",
  "why_has_link",
  "blocked_term",
] as const;
export type SocialIntentWhyResult = (typeof SOCIAL_INTENT_WHY_RESULTS)[number];

/** JSON Schema: `schemas/intent-response.schema.json`. */
export type SocialIntentRecorded = Readonly<z.infer<typeof socialIntentRecordedSchema>>;

/**
 * How long the caller waits for a registration before executing anyway
 * (AC-096). The transaction is signed by then: a slow or broken social layer
 * must cost the person their attribution, never their commit.
 */
export const INTENT_REGISTER_TIMEOUT_MS = 3_000;

/** The statuses the worker moves an intent to (`social_intents.status`). */
export const SOCIAL_INTENT_STATUSES = ["pending", "applied", "rejected_sender", "late"] as const;
export type SocialIntentStatus = (typeof SOCIAL_INTENT_STATUSES)[number];

/**
 * How late a registration may be and still count (T-026, AC-097): an intent
 * registered more than this after its transaction's own timestamp is `late`,
 * attaches no why and credits no post. The dialog registers before execute, so
 * a legitimate registration is always earlier than its event.
 */
export const INTENT_LATE_AFTER_MS = 30_000;

/** How long an unresolved intent is kept before it is deleted (AC-099). */
export const INTENT_EXPIRY_MS = 24 * 60 * 60 * 1_000;

// Published wire contracts. Semantic request checks keep their ordered route refusals.
export const socialIntentRequestSchema = z.strictObject({
  action: z.enum(["commit"]),
  presale_id: z.string().regex(SUI_OBJECT_ID_PATTERN),
  tx_digest: z.string().regex(new RegExp("^[1-9A-HJ-NP-Za-km-z]{32,44}$", "u")),
  source_entry_id: z.string().refine((value) => [...value].length >= 1).refine((value) => [...value].length <= 512).meta({"minLength": 1, "maxLength": 512}).optional(),
  why: z.string().refine((value) => [...value].length <= 1120).meta({"maxLength": 1120}).optional(),
  quote_type: z.string().regex(COIN_TYPE).refine((value) => [...value].length <= 512).meta({"maxLength": 512}).optional(),
  quote_amount: z.string().regex(new RegExp("^(0|[1-9][0-9]{0,19})$", "u")).optional(),
  usd_value: z.string().regex(new RegExp("^(0|[1-9][0-9]{0,17})(\\.[0-9]{1,2})?$", "u")).optional(),
  transaction_bytes: z.string().regex(new RegExp("^[A-Za-z0-9+/]+={0,2}$", "u")).refine((value) => [...value].length >= 1).refine((value) => [...value].length <= 180000).meta({"description": "Canonical base64 full Sui TransactionData bytes. Required before execution; digest and sender must match the caller’s server-proven Blast wallet.", "minLength": 1, "maxLength": 180000}).optional(),
}).meta({"title": "Social intent registration", "description": "POST /api/social/intents body (T-024). Closed: the action, the presale, the signed transaction's digest, and optionally the item the viewer acted through and their why. Only action \"commit\" is accepted; \"buy\" and \"sell\" belong to the swap feature and are refused with invalid_request until it exists. The why's text rules (NFC, trimmed, 1 to 280 code points, one line, no link, no blocked term) are not enforced here: a failed why is reported in the answer and the intent is still recorded, because the transaction is already signed. The three amount fields are the commit's transaction-log facts (R3-27): the coin it is counted in, its atoms in that coin, and its dollar value at submission; quote_amount requires quote_type."}).refine((body) => body.quote_amount === undefined || body.quote_type !== undefined).meta({ dependentRequired: { quote_amount: ["quote_type"] } });

export const socialIntentRecordedSchema = z.strictObject({
  status: z.enum(["recorded", "duplicate"]),
  why: z.enum(["accepted", "why_empty", "why_too_long", "why_invalid", "why_has_link", "blocked_term"]).nullable(),
}).meta({"title": "Social intent recorded", "description": "Answer of POST /api/social/intents: 201 the first time this digest is registered, 200 when this account already registered it. \"why\" is null when none was sent and on a duplicate, \"accepted\" when it was stored, and otherwise the published code that refused it. A refused why is not stored and the intent is still recorded."});
