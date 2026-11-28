import { z } from "zod";

import { MIGRATOR_VENUES, type MigratorVenue as CreateVenue } from "@blast/core/modules/launchpad-contract/venues.ts";
import { SUI_COIN_TYPE, SUI_USDT_COIN_TYPE, USDC_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { SALE_TAGLINE_MAX, socialSaleCoverSourceSchema, type SocialSaleCover } from "@blast/core/modules/social/contracts/sales.ts";
import { socialUuidSchema } from "./primitives.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

/**
 * Create (social-feed UI-20, the live canonical UI's "Create a presale"): a
 * signed-in account's presale drafts, kept on the server so they autosave
 * and survive a reload or another device, and the publish plan that turns a
 * finished draft into the presale's creation transactions. Every route is
 * the account's own data: `auth: "account"`, an account required,
 * `Cache-Control: private, no-store`.
 *
 * - `GET /api/social/me/drafts?cursor=&limit=`: the account's drafts, most
 *   recently saved first, keyset paged (`create-draft-page`).
 *   `resume=true` restores only drafts edited after the account's latest publication.
 * - `GET /api/social/me/drafts/{id}`: one draft (`create-draft-response`).
 * - `PUT /api/social/me/drafts/{id}` `{ version, draft }`
 *   (`create-draft-request`): creates the draft at `version: 0` or replaces
 *   it at its current `version` (optimistic concurrency). The client picks
 *   the id (a UUID), so a retried create is harmless; a retried replace whose
 *   body is already stored answers the stored draft. Another version is
 *   `409 draft_conflict` with the stored draft in `error.draft`.
 * - `DELETE /api/social/me/drafts/{id}`: removes it; repeating is harmless (204).
 * - `PUT /api/social/me/drafts/{id}/logo`: the coin's image as the body
 *   (PNG, JPEG or WebP, at most 2 MiB), re-encoded to a 512 px square WebP in
 *   the public launch-asset store; answers the draft.
 * - `POST /api/social/me/drafts/{id}/cover` (R3-25): the sale's cover as
 *   `multipart/form-data` with one `cover` file (PNG, JPEG or WebP, at most
 *   4 MB; SVG refused), re-encoded through R3-24's `SALE_COVER_IMAGE` to a
 *   1536 × 512 WebP under `draft-covers/{id}/`; the logo's auth and bucket,
 *   `invalid_cover` / `cover_upload_unavailable`; answers the draft.
 *   `DELETE` removes it and answers the draft. Both are `409 draft_published`
 *   once the draft's sale is published (the sale's cover is then the sale's).
 * - `POST /api/social/me/drafts/{id}/published` (R3-25) `{ presale_id }`:
 *   records that the draft became that sale (the account must hold its
 *   `PresaleCap`, `403 not_sale_creator`) and, in the same transaction, writes
 *   the draft's tagline, links and cover into the sale's details (R3-24).
 *   Once only: a repeat with the same sale answers the details as they are;
 *   another sale is `409 draft_published`.
 * - `POST /api/social/me/drafts/{id}/publish`: the publish plan, or
 *   `409 publish_unavailable` with the reasons publishing is off.
 *
 * Every figure in a draft is a JSON number with a bound that keeps the
 * on-chain conversion exact: dollars have at most two decimals and are at
 * most `CREATE_MAX_USD`; the supply is whole tokens of a 9-decimal coin; BPS
 * are integers from 0 to 10,000; the pool fee is in millionths.
 */

export const SOCIAL_CREATE_DRAFTS_ROUTE = "GET /api/social/me/drafts";
export const SOCIAL_CREATE_DRAFTS_PATH = "/api/social/me/drafts";
export const SOCIAL_CREATE_DRAFT_READ_ROUTE = "GET /api/social/me/drafts/{id}";
export const SOCIAL_CREATE_DRAFT_SAVE_ROUTE = "PUT /api/social/me/drafts/{id}";
export const SOCIAL_CREATE_DRAFT_DELETE_ROUTE = "DELETE /api/social/me/drafts/{id}";
export const SOCIAL_CREATE_DRAFT_LOGO_ROUTE = "PUT /api/social/me/drafts/{id}/logo";
export const SOCIAL_CREATE_DRAFT_PUBLISH_ROUTE = "POST /api/social/me/drafts/{id}/publish";
export const SOCIAL_CREATE_DRAFT_COVER_ROUTE = "POST /api/social/me/drafts/{id}/cover";
export const SOCIAL_CREATE_DRAFT_COVER_DELETE_ROUTE = "DELETE /api/social/me/drafts/{id}/cover";
export const SOCIAL_CREATE_DRAFT_PUBLISHED_ROUTE = "POST /api/social/me/drafts/{id}/published";

/** `/api/social/me/drafts/{id}`. */
export function socialCreateDraftPath(id: string): string {
  return `${SOCIAL_CREATE_DRAFTS_PATH}/${encodeURIComponent(id)}`;
}

/** `/api/social/me/drafts/{id}/logo`. */
export function socialCreateDraftLogoPath(id: string): string {
  return `${socialCreateDraftPath(id)}/logo`;
}

/** `/api/social/me/drafts/{id}/publish`. */
export function socialCreateDraftPublishPath(id: string): string {
  return `${socialCreateDraftPath(id)}/publish`;
}

/** `/api/social/me/drafts/{id}/cover`. */
export function socialCreateDraftCoverPath(id: string): string {
  return `${socialCreateDraftPath(id)}/cover`;
}

/** `/api/social/me/drafts/{id}/published`. */
export function socialCreateDraftPublishedPath(id: string): string {
  return `${socialCreateDraftPath(id)}/published`;
}

/** A draft id: a lowercase UUID the client generates. */
export const CREATE_DRAFT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const CREATE_DRAFT_PAGE_DEFAULT_LIMIT = 20;
export const CREATE_DRAFT_PAGE_MAX_LIMIT = 50;
/** A save body is at most 64 KiB (64 token and 64 raise recipients and 16 fee recipients fit in about 25 KiB). */
export const CREATE_DRAFT_BODY_LIMIT_BYTES = 64 * 1_024;
export const CREATE_LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
/** The largest logo upload (the design: "Use an image under 2 MB"). */
export const CREATE_LOGO_MAX_BYTES = 2 * 1_024 * 1_024;
export const CREATE_LOGO_SIDE = 512;
export const CREATE_LOGO_MIN_SIDE = 64;
export const CREATE_LOGO_REJECTIONS = ["type", "undecodable", "animated", "dimensions"] as const;
export type CreateLogoRejection = (typeof CREATE_LOGO_REJECTIONS)[number];

/** The mainnet USDC coin type a Create presale raises by default (normalized). */
export const CREATE_QUOTE_TYPE = USDC_COIN_TYPE;

/** R3-42: SUI's coin type (normalized), the other quote a sale can raise. */
export const CREATE_SUI_QUOTE_TYPE = SUI_COIN_TYPE;

/**
 * R3-42: a quote coin a creator can pick (the gate's `QUOTE_COINS`, in its
 * order): its type, symbol, decimals, name and the picker's subtitle (R3-86,
 * the gate's `QUOTE_SUB`: what the target and prices read in). These are
 * the coins the product holds balances in and formats (R3-40). Which of them
 * a draft may pick **now** is the server's answer (`CreateDraftResponse.quotes`),
 * not this list: the deployed `CreationPolicy` must admit it, SUI needs an
 * indexed conversion price, and TEST_SUI needs the development opt-in.
 */
export const CREATE_TEST_SUI_QUOTE_TYPE = "0x963331df9a26c8674c33eb97655fe44807d5ff1aa4092bcbe2bdbe044b17b03d::test_sui::TEST_SUI";

/** Mainnet test coins hidden from discovery, including the separately launched TSUI. */
export const TEST_SUI_COIN_TYPES: readonly string[] = [
  CREATE_TEST_SUI_QUOTE_TYPE,
  "0xbb95f095a7601a3500ee0a6983459a21ed1c91253ea2a2599eeb1e1ead76ef83::tsui::TSUI",
];

/** Canonical mainnet USDsui, with six decimal places. */
export const CREATE_USDSUI_QUOTE_TYPE = "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI";

/** Quote coins valued at one USD per whole coin for presales. */
export const PRESALE_PAR_QUOTE_TYPES: readonly string[] = Object.freeze([
  USDC_COIN_TYPE,
  CREATE_USDSUI_QUOTE_TYPE,
  SUI_USDT_COIN_TYPE,
]);

/** Canonical mainnet WAL, with nine decimal places. */
export const CREATE_WAL_QUOTE_TYPE = "0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL";

/** Canonical mainnet DEEP (DeepBook), with six decimal places. */
export const CREATE_DEEP_QUOTE_TYPE = "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP";

/** Canonical mainnet hashiBTC, with eight decimal places. */
export const CREATE_HASHI_BTC_QUOTE_TYPE = "0xd30fb3f8914efdbeb7b8e85fae1d65dc584b44a1281f66737b92bb9f03a59d06::btc::BTC";

export type CreateQuote = Readonly<{ quote_type: string; symbol: "SUI" | "USDC" | "USDsui" | "WAL" | "DEEP" | "hashiBTC" | "TEST_SUI"; decimals: number; name: string; note: string }>;

export const CREATE_QUOTES: readonly CreateQuote[] = Object.freeze([
  { quote_type: CREATE_SUI_QUOTE_TYPE, symbol: "SUI", decimals: 9, name: "Sui", note: "Target and prices in SUI" },
  { quote_type: CREATE_QUOTE_TYPE, symbol: "USDC", decimals: 6, name: "USD Coin", note: "Target and prices in dollars" },
  { quote_type: CREATE_USDSUI_QUOTE_TYPE, symbol: "USDsui", decimals: 6, name: "USDsui", note: "Target and prices in USDsui" },
  { quote_type: CREATE_WAL_QUOTE_TYPE, symbol: "WAL", decimals: 9, name: "Walrus", note: "Target and prices in WAL" },
  { quote_type: CREATE_DEEP_QUOTE_TYPE, symbol: "DEEP", decimals: 6, name: "DeepBook", note: "Target and prices in DEEP" },
  { quote_type: CREATE_HASHI_BTC_QUOTE_TYPE, symbol: "hashiBTC", decimals: 8, name: "Hashi BTC", note: "Target and prices in hashiBTC" },
  { quote_type: CREATE_TEST_SUI_QUOTE_TYPE, symbol: "TEST_SUI", decimals: 9, name: "Test Sui", note: "Fake coins for testing" },
]);

/** Create's quote coin types, normalized: the few coins every coin page prices its dollar rate from. */
export const CREATE_QUOTE_TYPES: ReadonlySet<string> = new Set(CREATE_QUOTES.map((quote) => quote.quote_type));

/** The quote of a coin type, or null for one Create does not raise. */
export function createQuoteOf(quoteType: string): CreateQuote | null {
  // RPC type tags may omit leading zeros in the package address.
  const canonical = quoteType.replace(/^0x([a-fA-F0-9]{1,64})(?=::)/, (_, address: string) => `0x${address.toLowerCase().padStart(64, "0")}`);
  return CREATE_QUOTES.find((quote) => quote.quote_type === canonical) ?? null;
}

/** The canonical asset supplying the display rate for this quote. */
export function quotePriceType(quoteType: string): string {
  const type = createQuoteOf(quoteType)?.quote_type ?? quoteType;
  return type === CREATE_TEST_SUI_QUOTE_TYPE ? CREATE_SUI_QUOTE_TYPE : type;
}

/** R3-42: the SUI row of `chain_read_v1.prices` the picker converts at (USD a whole SUI, and when it was taken). */
export type CreateQuotePrice = Readonly<{ usd_price: string; as_of_ms: number }>;

// ---- the contract's bounds (blast_presale.move, bluefin.move, fee_policy.move) ----

/** `MAX_PARTICIPANTS`: the most distinct wallets a sale admits. */
export const CREATE_MAX_WALLETS = 65_536;
/** `MAX_RECIPIENTS`: token or raise recipients. */
export const CREATE_MAX_RECIPIENTS = 64;
/** `MAX_FEE_RECIPIENTS`: LP-fee recipients besides holder rewards. */
export const CREATE_MAX_FEE_RECIPIENTS = 16;
export const CREATE_DECIMALS = [6, 9] as const;
/** The default precision, also used for older saved drafts. */
export const CREATE_TOKEN_DECIMALS = 9;
/** The largest whole-token supply whose atoms fit in a u64. */
export function createMaxSupply(decimals: number): number {
  return Number(((1n << 64n) - 1n) / 10n ** BigInt(decimals));
}
/** Product bound on dollars (target, caps, minimums): keeps USDC atoms exact and far inside u64. */
export const CREATE_MAX_USD = 10_000_000_000;
export const CREATE_NAME_MAX = 32;
export const CREATE_SYMBOL_MAX = 10;
export const CREATE_TAGLINE_MAX = SALE_TAGLINE_MAX;
/** The longest typed website, docs or audit link a draft keeps (a stored link is at most `SALE_LINK_MAX`). */
export const CREATE_LINK_MAX = 512;
/** The longest typed X handle or Telegram name a draft keeps (a valid one is 15 or 32). */
export const CREATE_HANDLE_MAX = 64;
export const CREATE_LABEL_MAX = 20;
export const BPS_DENOMINATOR = 10_000;

export const CREATE_SALE_DAYS = [1, 3, 7, 14] as const;
export type CreateSaleDays = (typeof CREATE_SALE_DAYS)[number];
/**
 * The furthest a scheduled start may be from the time the draft is checked:
 * a later one is almost surely a typo, and until a sale opens Blast's
 * `FeeAdmin` may still change its rates (`set_protocol_fees`).
 */
export const CREATE_START_MAX_AHEAD_MS = 90 * 86_400_000;
/** The launch window: `MIN_LIQUIDITY_WINDOW_MS` is seven days. */
export const CREATE_LP_DAYS = [7, 14, 30] as const;
export type CreateLpDays = (typeof CREATE_LP_DAYS)[number];
/** When limits lift, in hours before the close. */
export const CREATE_LIFT_HOURS = [1, 6, 24] as const;
export type CreateLiftHours = (typeof CREATE_LIFT_HOURS)[number];
export { MIGRATOR_VENUES as CREATE_VENUES, type CreateVenue };
export const CREATE_ELIGIBILITY = ["open", "allowlist"] as const;
export type CreateEligibility = (typeof CREATE_ELIGIBILITY)[number];
export const CREATE_LIFT_ACCESS = ["eligible", "anyone"] as const;
export type CreateLiftAccess = (typeof CREATE_LIFT_ACCESS)[number];

/**
 * Cetus fixes one fee per tick spacing in its mainnet `GlobalConfig`
 * (`[tick spacing, fee in millionths]`, the design's fork snapshot of
 * 2026-09-24). `cetus::new` reads the fee for the spacing on chain.
 */
export const CETUS_TIERS: readonly (readonly [number, number])[] = Object.freeze([
  [2, 100], [4, 200], [6, 300], [8, 400], [10, 500], [20, 1_000], [30, 1_500], [40, 2_000], [60, 2_500],
  [80, 3_000], [100, 4_000], [120, 6_000], [160, 8_000], [200, 10_000], [220, 20_000], [260, 40_000],
].map((tier) => Object.freeze(tier as [number, number])));
/** Bluefin takes any spacing up to 400 and any fee up to 2%, so it offers the same pairs capped at 2% (`MAX_POOL_FEE_RATE`). */
export const BLUEFIN_TIERS: readonly (readonly [number, number])[] = Object.freeze(CETUS_TIERS.filter(([, fee]) => fee <= 20_000));

export type CreateBuyerVesting = Pick<CreateRecipient, "vest" | "cliff" | "duration" | "cliff_unit" | "duration_unit">;

export type CreateRecipient = Readonly<Required<z.infer<typeof createRecipientSchema>>>;

export type CreateFeeRecipient = z.infer<typeof createDraftSchema>["fee_recipients"][number];

/** What the creator edits. The logo and the allowlist summary are the server's (see `CreateDraftResponse`). */
/** The normalized model supplies defaults for optional wire fields and recipient units. */
export type CreateDraft = Readonly<Omit<Required<z.infer<typeof createDraftSchema>>, "token_recipients" | "raise_recipients" | "quote_type" | "decimals"> & {
  token_recipients: readonly CreateRecipient[];
  raise_recipients: readonly CreateRecipient[];
  quote_type: string;
  decimals: number;
}>;

/** R3-25: the draft fields a save may omit (an older page's draft); `parseDraft` fills them. */
export const CREATE_DRAFT_OPTIONAL_KEYS = ["buyer_vesting", "decimals", "quote_type", "site", "x_handle", "telegram", "docs_url", "audit_url", "launch_when_filled", "start_ms"] as const;

/** R3-25: the draft's cover, written by the server (`…/cover`), with its upload's size (`SocialSaleCover`). */
export type CreateDraftCover = SocialSaleCover;

/** The allowlist a draft names, as the server read it when it was attached. */
export type CreateAllowlistSummary = Readonly<{
  allowlist_id: string;
  /** Merkle root, 64 lowercase hex digits. */
  root: string;
  leaf_count: number;
  /** The smallest and largest per-wallet cap, in whole coins of the list's quote. */
  min_cap: number;
  max_cap: number;
  /** R3-42: the coin the list's caps are in (the quote it was uploaded for); a draft raising another needs a new list. */
  quote_type: string;
  decimals?: number;
}>;

export const CREATE_SECTIONS = ["token", "links", "launch", "raise", "join", "split", "rsplit", "fees"] as const;
export type CreateSection = (typeof CREATE_SECTIONS)[number];

/** One thing to fix before publishing: its section, the field it is about, and the design's words. */
export type CreateIssue = Readonly<{ section: CreateSection; path: string; message: string }>;

/** Blast's rates, which a new presale snapshots from the shared `FeePolicy`, in BPS. */
export type CreateFeePolicy = Readonly<{
  raise_bps: number;
  token_bps: number;
  lp_fee_meme_bps: number;
  lp_fee_quote_bps: number;
  /** `chain`: read from the deployed `FeePolicy`; `config`: `SOCIAL_CREATE_FEE_POLICY` or the defaults, before the deploy. */
  source: "chain" | "config";
}>;

export type CreateDraftResponse = Readonly<Omit<z.infer<typeof createDraftResponseSchema>, "draft" | "quotes"> & {
  draft: CreateDraft;
  quotes: readonly string[];
}>;

export type CreateDraftRequest = Readonly<{ version: number; draft: CreateDraft }>;

export type CreateDraftListItem = z.infer<typeof createDraftPageSchema>["items"][number];

export type CreateDraftPage = Readonly<z.infer<typeof createDraftPageSchema>>;

/** Why publishing is off. Each is safe to show and to log. */
export const CREATE_PUBLISH_BLOCKERS = [
  // The published mainnet deployment is unavailable for signing.
  "presale_not_deployed",
  // The presale coin template must publish a sealed zero-supply treasury cap.
  "coin_template_missing",
  // The draft vests a share and the selected SDK cannot express vesting.
  "sdk_vesting_unsupported",
  // The deployed CreationPolicy does not admit the draft's quote (USDC or SUI) or this venue.
  "creation_policy",
  // The policy was read, but none of the offered raise coins is available.
  "quote_unavailable",
] as const;
export type CreatePublishBlocker = (typeof CREATE_PUBLISH_BLOCKERS)[number];

export type CreatePublishAvailability =
  | Readonly<{ available: true }>
  | Readonly<{ available: false; reasons: readonly CreatePublishBlocker[] }>;

const publishPackageIdSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const publishPackageSchema = z.strictObject({
  package_id: publishPackageIdSchema,
  original_package_id: publishPackageIdSchema,
  core_original_package_id: publishPackageIdSchema,
  deployment_fingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  venue: z.enum(MIGRATOR_VENUES),
});

const publishStepSchema = z.strictObject({
  kind: z.enum(["publish_coin", "register_currency", "create_presale"]),
  sponsorship: z.strictObject({
    reservation_id: socialUuidSchema,
    transaction_bytes: z.string().min(1),
  }).optional(),
  transaction: z.xor([z.null(), z.string().min(2)]),
  presale_package: publishPackageSchema.optional(),
});

export const createPublishPlanSchema = z.strictObject({
  draft_id: socialUuidSchema,
  version: z.number().min(1).refine(Number.isInteger).meta({ type: "integer" }),
  steps: z.array(publishStepSchema).min(1).max(3),
}).meta({
  title: "One step of a draft's publish plan",
  description: "POST /api/social/me/drafts/{id}/publish 200: the step's transaction as Transaction.toJSON(), sender set to the publishing wallet. Embedded wallets also receive a sponsorship reservation and full transaction bytes. 409 publish_unavailable carries error.reasons instead. Each step identifies the presale package so wallet execution errors can be decoded safely. A policy refusal carries error.contract_error (EQuoteNotAllowed or EMigrationWitnessNotAllowed); an unreadable policy has no contract_error. Sponsored simulation refusals carry error.move_abort.",
});

// A signing call consumes one actionable transaction and can resume older
// checkpoints that did not carry the core package ID or venue.
export const savedPublishPackageSchema = publishPackageSchema.partial({
  core_original_package_id: true,
  venue: true,
});
const signingPublishStepSchema = z.object({
  ...publishStepSchema.shape,
  transaction: z.string().min(1),
  presale_package: savedPublishPackageSchema.optional(),
  sponsorship: publishStepSchema.shape.sponsorship.unwrap().extend({
    reservation_id: z.string().uuid(),
  }).optional(),
});
export const createSigningPublishPlanSchema = z.object({
  draft_id: z.string(),
  version: z.number().int().positive(),
  steps: z.array(signingPublishStepSchema).length(1),
});

export type CreateSigningPublishPlan = z.infer<typeof createSigningPublishPlanSchema>;

export type CreatePublishStep = Readonly<z.infer<typeof publishStepSchema>>;
export type CreatePublishPlan = Readonly<{
  draft_id: z.infer<typeof createPublishPlanSchema>["draft_id"];
  version: z.infer<typeof createPublishPlanSchema>["version"];
  steps: readonly CreatePublishStep[];
}>;

// Published wire contracts. Semantic request checks keep their ordered route refusals.
export const createRecipientSchema = z.strictObject({
  label: z.string().refine((value) => [...value].length <= 20).meta({"maxLength": 20}),
  address: z.string().refine((value) => [...value].length <= 66).meta({"maxLength": 66}),
  bps: z.number().min(0).max(1000000).refine(Number.isInteger).meta({"type": "integer"}),
  vest: z.boolean(),
  cliff: z.number().min(0).max(9007199254740991).refine(Number.isInteger).meta({"type": "integer"}),
  duration: z.number().min(0).max(9007199254740991).refine(Number.isInteger).meta({"type": "integer"}),
  cliff_unit: z.enum(["months", "weeks", "days", "hours", "minutes", "seconds", "milliseconds"]).meta({ default: "months" }).optional(),
  duration_unit: z.enum(["months", "weeks", "days", "hours", "minutes", "seconds", "milliseconds"]).meta({ default: "months" }).optional(),
});

export const createDraftSchema = z.strictObject({
  name: z.string().refine((value) => [...value].length <= 32).meta({"maxLength": 32}),
  symbol: z.string().regex(new RegExp("^[A-Z0-9]{0,10}$", "u")),
  tagline: z.string().refine((value) => [...value].length <= CREATE_TAGLINE_MAX).meta({"maxLength": CREATE_TAGLINE_MAX}),
  supply: z.number().min(0).max(9007199254740991).refine(Number.isInteger).meta({"type": "integer"}),
  decimals: z.literal([6, 9]).meta({"type": "integer", "description": "Token precision: 6 or 9, defaulting to 9 for older drafts."}).optional(),
  burnable: z.boolean(),
  target: z.number().min(0).max(10000000000000),
  days: z.literal([1, 3, 7, 14]),
  eligibility: z.enum(["open", "allowlist"]),
  wallet_cap: z.number().min(0).max(10000000000000),
  min_commitment: z.number().min(0).max(10000000000000),
  max_wallets: z.number().min(0).max(655360).refine(Number.isInteger).meta({"type": "integer"}),
  allowlist_id: z.string().regex(new RegExp("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", "u")).nullable(),
  lift: z.boolean(),
  lift_hours: z.literal([1, 6, 24]),
  lift_access: z.enum(["eligible", "anyone"]),
  lift_max_wallets: z.number().min(0).max(655360).refine(Number.isInteger).meta({"type": "integer"}),
  lift_min: z.number().min(0).max(10000000000000),
  lift_hard_cap: z.boolean(),
  buyers_bps: z.number().min(0).max(1000000).refine(Number.isInteger).meta({"type": "integer"}),
  pool_bps: z.number().min(0).max(1000000).refine(Number.isInteger).meta({"type": "integer"}),
  token_recipients: z.array(createRecipientSchema).max(64).readonly(),
  raise_recipients: z.array(createRecipientSchema).max(64).readonly(),
  venue: z.enum(["cetus", "bluefin"]),
  pool_fee: z.number().min(1).max(1000000).refine(Number.isInteger).meta({"type": "integer"}),
  lp_days: z.literal([7, 14, 30]),
  start_ms: z.number().min(1).max(8640000000000000).refine(Number.isInteger).meta({"type": "integer"}).nullable().meta({"description": "When commitments open (epoch ms), or null to open them as the sale is published. Older drafts omit it (null)."}).optional(),
  launch_when_filled: z.boolean().meta({"description": "Close at the target with a hard cap from the start, independently of lifting wallet limits. Older drafts default to the scheduled end."}).optional(),
  holders_bps: z.number().min(0).max(1000000).refine(Number.isInteger).meta({"type": "integer"}),
  fee_recipients: z.array(z.strictObject({
    self: z.boolean(),
    label: z.string().refine((value) => [...value].length <= 20).meta({"maxLength": 20}),
    address: z.string().refine((value) => [...value].length <= 66).meta({"maxLength": 66}),
    bps: z.number().min(0).max(1000000).refine(Number.isInteger).meta({"type": "integer"}),
  })).min(1).max(16).readonly(),
  quote_type: z.enum(["0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI", "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI", "0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL", "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP", "0xd30fb3f8914efdbeb7b8e85fae1d65dc584b44a1281f66737b92bb9f03a59d06::btc::BTC", "0x963331df9a26c8674c33eb97655fe44807d5ff1aa4092bcbe2bdbe044b17b03d::test_sui::TEST_SUI"]).meta({"description": "The coin the sale raises: USDC (the default), SUI, USDsui, WAL, DEEP, hashiBTC, or TEST_SUI for test sales. Every amount is in this coin. Optional on a save; always in an answer."}).optional(),
  site: z.string().refine((value) => [...value].length <= 512).meta({"description": "R3-25: the links as typed (each optional, blank when unset); a wrong one is an issue in the links section. Optional on a save; always in an answer.", "maxLength": 512}).optional(),
  x_handle: z.string().refine((value) => [...value].length <= 512).meta({"description": "A pasted profile link or an @ is accepted and kept as the bare handle (at most 64 characters).", "maxLength": 512}).optional(),
  telegram: z.string().refine((value) => [...value].length <= 512).meta({"maxLength": 512}).optional(),
  docs_url: z.string().refine((value) => [...value].length <= 512).meta({"maxLength": 512}).optional(),
  audit_url: z.string().refine((value) => [...value].length <= 512).meta({"maxLength": 512}).optional(),
  buyer_vesting: z.strictObject({
    vest: z.boolean(),
    cliff: z.number().min(0).max(9007199254740991).refine(Number.isInteger).meta({"type": "integer"}),
    duration: z.number().min(0).max(9007199254740991).refine(Number.isInteger).meta({"type": "integer"}),
    cliff_unit: z.enum(["months", "weeks", "days", "hours", "minutes", "seconds", "milliseconds"]).meta({ default: "months" }),
    duration_unit: z.enum(["months", "weeks", "days", "hours", "minutes", "seconds", "milliseconds"]).meta({ default: "months" }),
  }).optional(),
}).meta({"title": "A presale draft", "description": "What the creator edits on the Create page (contracts/create.ts CreateDraft). Dollars have at most two decimals; BPS may exceed 10,000 while the form is being filled (the totals then say so); the creator's own fee row is the first and only one with self: true."});

export const createDraftRequestSchema = z.strictObject({
  version: z.number().min(0).max(2147483647).refine(Number.isInteger).meta({"type": "integer"}),
  draft: createDraftSchema,
}).meta({"title": "Save a presale draft", "description": "PUT /api/social/me/drafts/{id}: version 0 creates, the stored version replaces."});

export const createDraftResponseSchema = z.strictObject({
  draft_id: z.string().regex(new RegExp("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", "u")),
  version: z.number().min(1).refine(Number.isInteger).meta({"type": "integer"}),
  created_at_ms: z.number().min(0).refine(Number.isInteger).meta({"type": "integer"}),
  updated_at_ms: z.number().min(0).refine(Number.isInteger).meta({"type": "integer"}),
  draft: createDraftSchema,
  logo_url: z.string().regex(new RegExp("^https://\\S{1,2040}$", "u")).nullable(),
  cover: z.strictObject({
    url: z.string().regex(new RegExp("^https://\\S{1,2040}$", "u")),
    width: z.number().min(1).refine(Number.isInteger).meta({"type": "integer"}),
    height: z.number().min(1).refine(Number.isInteger).meta({"type": "integer"}),
    source: socialSaleCoverSourceSchema.optional(),
  }).nullable().meta({"description": "R3-25: the sale's cover, re-encoded to 1536 x 512 (POST …/cover), or null."}),
  published_presale_id: z.string().regex(SUI_OBJECT_ID_PATTERN).nullable().meta({"description": "R3-25: the sale this draft was published as (POST …/published), or null."}),
  allowlist: z.strictObject({
    allowlist_id: z.string().regex(new RegExp("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", "u")),
    root: z.string().regex(new RegExp("^[0-9a-f]{64}$", "u")),
    leaf_count: z.number().min(1).max(65536).refine(Number.isInteger).meta({"type": "integer"}),
    min_cap: z.number().min(0),
    max_cap: z.number().min(0),
    quote_type: z.string().meta({"description": "R3-42: the coin the list's caps are in (min_cap and max_cap are whole coins of it)."}),
  }).nullable(),
  issues: z.array(z.strictObject({
    section: z.enum(["token", "links", "raise", "join", "split", "rsplit", "launch", "fees"]),
    path: z.string().regex(new RegExp("^[a-z_]+(\\.[0-9]+\\.[a-z_]+)?$", "u")),
    message: z.string().refine((value) => [...value].length >= 1).refine((value) => [...value].length <= 200).meta({"minLength": 1, "maxLength": 200}),
  })).max(400).readonly(),
  fee_policy: z.strictObject({
    raise_bps: z.number().min(0).max(9999).refine(Number.isInteger).meta({"type": "integer"}),
    token_bps: z.number().min(0).max(9998).refine(Number.isInteger).meta({"type": "integer"}),
    lp_fee_meme_bps: z.number().min(0).max(10000).refine(Number.isInteger).meta({"type": "integer"}),
    lp_fee_quote_bps: z.number().min(0).max(10000).refine(Number.isInteger).meta({"type": "integer"}),
    source: z.enum(["chain", "config"]),
  }),
  quotes: z.array(z.enum(["0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI", "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI", "0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL", "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP", "0xd30fb3f8914efdbeb7b8e85fae1d65dc584b44a1281f66737b92bb9f03a59d06::btc::BTC", "0x963331df9a26c8674c33eb97655fe44807d5ff1aa4092bcbe2bdbe044b17b03d::test_sui::TEST_SUI"])).min(0).refine((items) => new Set(items).size === items.length).readonly().meta({"description": "Known quote types admitted by the deployed CreationPolicy. SUI also requires a conversion price; TEST_SUI requires the development opt-in. Empty when the live policy cannot be read or no quote is available.", "uniqueItems": true}),
  cetus_tiers: z.record(z.string(), z.array(z.tuple([z.number().min(1).refine(Number.isInteger).meta({"type": "integer"}), z.number().min(1).refine(Number.isInteger).meta({"type": "integer"})]).readonly()).readonly()).nullable().meta({"description": "Live permissioned Cetus tiers keyed by quote type, or null when verification failed."}).optional(),
  bluefin_options: z.xor([
    z.strictObject({
      status: z.literal("unavailable"),
    }),
    z.strictObject({
      status: z.literal("ready"),
      min_tick: z.number().refine(Number.isInteger).meta({"type": "integer"}),
      max_tick: z.number().refine(Number.isInteger).meta({"type": "integer"}),
    })
  ]).optional(),
  sui_price: z.strictObject({
    usd_price: z.string().regex(new RegExp("^(0|[1-9][0-9]*)(\\.[0-9]+)?$", "u")),
    as_of_ms: z.number().min(0).refine(Number.isInteger).meta({"type": "integer"}),
  }).nullable().meta({"description": "R3-42: SUI's chain_read_v1.prices row the picker converts at; null without one."}),
}).meta({"title": "A presale draft as saved", "description": "GET or PUT /api/social/me/drafts/{id} (and the logo upload): the draft, its server-owned logo and allowlist summary, what is left to fix, and Blast's rates the issues were checked with. Cache-Control: private, no-store."});

export const createDraftPageSchema = z.strictObject({
  items: z.array(z.strictObject({
    draft_id: z.string().regex(new RegExp("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", "u")),
    version: z.number().min(1).refine(Number.isInteger).meta({"type": "integer"}),
    name: z.string().refine((value) => [...value].length <= 32).meta({"maxLength": 32}),
    symbol: z.string().refine((value) => [...value].length <= 10).meta({"maxLength": 10}),
    target: z.number().min(0),
    logo_url: z.string().regex(new RegExp("^https://\\S{1,2040}$", "u")).nullable(),
    updated_at_ms: z.number().min(0).refine(Number.isInteger).meta({"type": "integer"}),
  })).max(50).readonly(),
  next_cursor: z.string().regex(new RegExp("^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{12}$", "u")).refine((value) => [...value].length <= 256).meta({"maxLength": 256}).nullable(),
}).meta({"title": "A page of the caller's presale drafts", "description": "GET /api/social/me/drafts: most recently saved first (keyset), and the next page's cursor. With resume=true, only drafts edited after the account's latest publication are returned."});
