import { z } from "zod";

import { exactDecimal, numShortExact } from "@blast/core/lib/exact-amount.ts";
import { isWholeSuiAddressInput } from "@blast/core/lib/sui/ids.ts";
import { short } from "@blast/core/lib/compact-dollars.ts";
import { MAX_VESTING_DURATION_MS } from "@interest-protocol/blast-sdk";
import { VESTING_UNITS, vestingDurationMs } from "@blast/core/modules/social/contracts/vesting.ts";
import {
  BLUEFIN_TIERS,
  BPS_DENOMINATOR,
  CETUS_TIERS,
  CREATE_DECIMALS,
  CREATE_DRAFT_OPTIONAL_KEYS,
  CREATE_ELIGIBILITY,
  CREATE_HANDLE_MAX,
  CREATE_LABEL_MAX,
  CREATE_LINK_MAX,
  CREATE_LIFT_ACCESS,
  CREATE_LIFT_HOURS,
  CREATE_LP_DAYS,
  CREATE_MAX_FEE_RECIPIENTS,
  CREATE_MAX_RECIPIENTS,
  CREATE_MAX_USD,
  CREATE_MAX_WALLETS,
  CREATE_NAME_MAX,
  CREATE_QUOTE_TYPE,
  CREATE_QUOTES,
  CREATE_USDSUI_QUOTE_TYPE,
  CREATE_SALE_DAYS,
  CREATE_START_MAX_AHEAD_MS,
  CREATE_SYMBOL_MAX,
  CREATE_TAGLINE_MAX,
  CREATE_TOKEN_DECIMALS,
  CREATE_VENUES,
  createMaxSupply,
  type CreateAllowlistSummary,
  type CreateDraft,
  type CreateFeePolicy,
  type CreateFeeRecipient,
  type CreateIssue,
  type CreateQuote,
  type CreateQuotePrice,
  type CreateRecipient,
  type CreateSection,
  type CreateVenue,
} from "@blast/core/modules/social/contracts/create.ts";
import { bareTelegram, bareXHandle, normalizeSaleLink, normalizeTelegram, normalizeXHandle } from "@blast/core/modules/social/sales/validate.ts";
import { isReservedCoinIdentity } from "@blast/core/modules/social/create/reserved-coins.ts";
import { presaleTargetDecimals } from "@blast/core/modules/social/create/minimum-raise.ts";

/**
 * The Create form's rules (the live design's "reading and checking the
 * draft"), shared by the page, its live preview and the server: a blank
 * draft, the strict shape a saved draft must have, the figures the preview
 * shows, and what is left to fix before publishing. Every message is the
 * design's own; the checks the design leaves to the contract (`blast_presale::new`
 * and the venue `new`) are added with the same voice (OA-13).
 */

/** Blast's rates before the deploy, as the design shows them (`FEE_POLICY`, demo values until the `FeePolicy` is read). */
export const CREATE_DEFAULT_FEE_POLICY: CreateFeePolicy = Object.freeze({
  raise_bps: 200,
  token_bps: 100,
  lp_fee_meme_bps: 1_500,
  lp_fee_quote_bps: 1_500,
  source: "config",
});

const recipient = (label: string, bps: number, vest?: readonly [number, number]): CreateRecipient => ({
  label,
  address: "",
  bps,
  vest: Boolean(vest),
  cliff: vest ? vest[0] : 0,
  duration: vest ? vest[1] : 12,
  cliff_unit: "months",
  duration_unit: "months",
});

/** A new token or raise recipient row (the design's `crRec('', 0)`). */
export function emptyRecipient(): CreateRecipient {
  return recipient("", 0);
}

/** A new LP-fee recipient row. */
export function emptyFeeRecipient(): CreateFeeRecipient {
  return { self: false, label: "", address: "", bps: 0 };
}

/** The design's `crBlank()`: a 1B supply, a $250K target over three days, and its suggested splits. */
export function blankDraft(quoteType = CREATE_QUOTE_TYPE): CreateDraft {
  return {
    name: "",
    symbol: "",
    tagline: "",
    supply: 1_000_000_000,
    decimals: CREATE_TOKEN_DECIMALS,
    burnable: false,
    target: 250_000,
    days: 3,
    eligibility: "open",
    wallet_cap: 25_000,
    min_commitment: 10,
    max_wallets: 30_000,
    allowlist_id: null,
    lift: false,
    lift_hours: 6,
    lift_access: "eligible",
    lift_max_wallets: 40_000,
    lift_min: 10,
    lift_hard_cap: true,
    buyers_bps: 4_500,
    buyer_vesting: { vest: false, cliff: 0, duration: 12, cliff_unit: "months", duration_unit: "months" },
    pool_bps: 3_000,
    token_recipients: [recipient("Team", 1_900, [3, 12]), recipient("Treasury", 500)],
    raise_recipients: [recipient("Team", 2_300, [0, 6])],
    venue: "cetus",
    pool_fee: 10_000,
    lp_days: 7,
    launch_when_filled: false,
    start_ms: null,
    holders_bps: 5_000,
    fee_recipients: [{ self: true, label: "You", address: "", bps: 5_000 }],
    quote_type: quoteType,
    site: "",
    x_handle: "",
    telegram: "",
    docs_url: "",
    audit_url: "",
  };
}

/** R3-25: the links, each refused in the gate's words (the design's `crIssues`, `links` section). */
const LINK_CHECKS: readonly (readonly [keyof CreateDraft & ("site" | "docs_url" | "audit_url"), string])[] = [
  ["site", "Website isn't a web address"],
  ["docs_url", "Docs isn't a web address"],
  ["audit_url", "Audit report isn't a web address"],
];

/** The venue's pool-fee tiers, `[tick spacing, fee in millionths]`. */
export function venueTiers(venue: CreateVenue): readonly (readonly [number, number])[] {
  return venue === "cetus" ? CETUS_TIERS : BLUEFIN_TIERS;
}

/** The tier with this fee, or the nearest one (switching venue keeps the closest fee, as the design does). */
export function nearestTierFee(venue: CreateVenue, fee: number): number {
  const tiers = venueTiers(venue);
  if (tiers.some(([, f]) => f === fee)) return fee;
  return tiers.reduce((best, [, f]) => (Math.abs(f - fee) < Math.abs(best - fee) ? f : best), tiers[0]![1]);
}

// ---- formats the messages use ----

/** BPS as the design's percent: `19%`, `0.5%`, `12.35%`. */
export function pctText(bps: number): string {
  return `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
}

const count = (value: number) => value.toLocaleString("en-US");

const ZERO_ADDRESS = /^0x0{64}$/i;

export const sumBps = (shares: readonly { bps: number }[]): number => shares.reduce((sum, share) => sum + (share.bps || 0), 0);

// ---- the quote (R3-42) ----

/** The draft's quote coin: its own `quote_type`, USDC for anything Create does not raise. */
export function draftQuote(draft: Pick<CreateDraft, "quote_type">): CreateQuote {
  return CREATE_QUOTES.find((quote) => quote.quote_type === draft.quote_type) ?? CREATE_QUOTES.find((quote) => quote.symbol === "USDC")!;
}

/**
 * A draft amount compact in its coin (the gate's `qs`): `$400K` for a USDC
 * draft, `100K SUI` for a SUI one — exact from the amount's two decimals.
 */
export function draftShort(draft: Pick<CreateDraft, "quote_type">, amount: number): string {
  const quote = draftQuote(draft);
  if (quote.symbol === "USDC") return short(amount);
  const value = exactDecimal(Math.max(0, amount).toFixed(2));
  return `${value === null ? "0" : numShortExact(value)} ${quote.symbol}`;
}

/** An exact non-negative rational `n / d`. */
type Ratio = Readonly<{ n: bigint; d: bigint }>;

function ratioOf(text: string): Ratio | null {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(text);
  if (!match) return null;
  const fraction = match[2] ?? "";
  return { n: BigInt(match[1] + fraction), d: 10n ** BigInt(fraction.length) };
}

/** `ratio` rounded half up to a whole number. */
function roundRatio(ratio: Ratio): bigint {
  return (ratio.n * 2n + ratio.d) / (ratio.d * 2n);
}

/**
 * The gate's `niceRound`, exactly: under 100, the nearest whole number (at
 * least 1); from 100 up, two significant digits — `29,239.77 → 29,000`,
 * `136.8 → 140`, `85.5 → 86`. Rounds half up, as `Math.round` does for a
 * positive number, without the float.
 */
export function niceRound(ratio: Ratio): number {
  const whole = ratio.n / ratio.d;
  if (whole < 100n) {
    const rounded = roundRatio(ratio);
    return Number(rounded < 1n ? 1n : rounded);
  }
  const power = 10n ** BigInt(whole.toString().length - 2);
  return Number(roundRatio({ n: ratio.n, d: ratio.d * power }) * power);
}

/** The draft's amounts the picker converts: the target, the limits and the minimums (the gate's `target, cap, min, phaseMin`). */
export const QUOTE_CONVERTED = ["target", "wallet_cap", "min_commitment", "lift_min"] as const;

/**
 * Whether a list uploaded for `listQuote` serves a draft raising `saleQuote`:
 * the same coin, or USDC and USDsui, whose caps are the same dollars in the
 * same six decimals. Other coins never share a list: SUI and WAL share
 * decimals but not a price.
 */
export function allowlistFitsQuote(listQuote: string, saleQuote: string): boolean {
  const dollars = [CREATE_QUOTE_TYPE, CREATE_USDSUI_QUOTE_TYPE];
  return listQuote === saleQuote || (dollars.includes(listQuote) && dollars.includes(saleQuote));
}

/**
 * R3-42: the draft raising `to` instead, the gate's `openQuotePicker`: every
 * converted amount at `price` (USD a whole SUI, `chain_read_v1.prices`'
 * row) — divided going to SUI, multiplied going to USDC — then rounded to a
 * round number (`niceRound`); an amount of zero stays zero. Exact: the
 * amounts and the price are integers over powers of ten. Null when nothing
 * can be converted honestly: no price (never a guessed rate), the same coin,
 * or a coin Create does not raise.
 *
 * USDsui and WAL switches retain the entered coin amounts because this response
 * carries no exchange rate for either coin; the picker asks the creator to review them.
 * Only an explicit pick calls this; a reload, a save or a publish never
 * converts (R3-42-AC-3). An uploaded allowlist is not rescaled — its caps are
 * each wallet's, signed into its root — so the draft keeps the list and
 * `draftIssues` asks for a new one in the new coin, unless the list still fits
 * it (`allowlistFitsQuote`: USDC and USDsui).
 */
export function switchDraftQuote(draft: CreateDraft, to: string, price: CreateQuotePrice | null): CreateDraft | null {
  const from = draftQuote(draft);
  const target = CREATE_QUOTES.find((quote) => quote.quote_type === to);
  if (!target || target.quote_type === from.quote_type) return null;
  // Only SUI/USDC have a conversion price. Keep other coin amounts explicit.
  if (![from.symbol, target.symbol].every((symbol) => symbol === "SUI" || symbol === "USDC")) {
    return { ...draft, quote_type: target.quote_type, target: Number(draft.target.toFixed(presaleTargetDecimals(target.quote_type))) };
  }
  if (price === null) return null;
  const rate = ratioOf(price.usd_price);
  if (rate === null || rate.n === 0n) return null;
  const next: Record<string, unknown> = { ...draft, quote_type: target.quote_type };
  for (const key of QUOTE_CONVERTED) {
    const amount = ratioOf(draft[key].toFixed(2));
    if (amount === null || amount.n === 0n) continue;
    // To SUI: dollars ÷ (USD per SUI); to USDC: SUI × (USD per SUI).
    const converted = target.symbol === "SUI"
      ? { n: amount.n * rate.d, d: amount.d * rate.n }
      : { n: amount.n * rate.n, d: amount.d * rate.d };
    next[key] = niceRound(converted);
  }
  return next as CreateDraft;
}

// ---- the preview's figures ----

export type CreateTerms = Readonly<{
  buyersTokens: number;
  poolTokens: number;
  /** The raise's share left for the pool, in BPS (may be ≤ 0 while the form is wrong). */
  lpBps: number;
  /** Presale price, dollars per token. */
  price: number;
  /** Dollars that seed the pool. */
  poolQuote: number;
  /** The pool's opening price, dollars per token. */
  launch: number;
  /** Value at launch: the opening price times the supply. */
  fdv: number;
  /** The opening price over the presale price, in percent. */
  premium: number;
}>;

/** The design's `crTerms`. */
export function draftTerms(draft: CreateDraft, fees: CreateFeePolicy): CreateTerms {
  const buyersTokens = (draft.supply * draft.buyers_bps) / BPS_DENOMINATOR;
  const poolTokens = (draft.supply * draft.pool_bps) / BPS_DENOMINATOR;
  const lpBps = BPS_DENOMINATOR - fees.raise_bps - sumBps(draft.raise_recipients);
  const price = buyersTokens > 0 ? draft.target / buyersTokens : 0;
  const poolQuote = (draft.target * Math.max(0, lpBps)) / BPS_DENOMINATOR;
  const launch = poolTokens > 0 ? poolQuote / poolTokens : 0;
  return { buyersTokens, poolTokens, lpBps, price, poolQuote, launch, fdv: launch * draft.supply, premium: price ? (launch / price - 1) * 100 : 0 };
}

/** The wallets an open-to-anyone phase admits beyond the sale's own bound, and that bound. */
export function liftSlots(draft: CreateDraft, allowlist: CreateAllowlistSummary | null): Readonly<{ bound: number; slots: number }> {
  const bound = draft.eligibility === "open" ? draft.max_wallets : (allowlist?.leaf_count ?? 0);
  return { bound, slots: draft.eligibility === "open" ? draft.lift_max_wallets : draft.lift_max_wallets - bound };
}

// ---- what is left to fix ----

export type IssueContext = Readonly<{
  fees: CreateFeePolicy;
  /** The allowlist the draft names, when the server has read it. */
  allowlist: CreateAllowlistSummary | null;
  /** The check time: a scheduled start must be after it and within `CREATE_START_MAX_AHEAD_MS`. The server always passes it. */
  nowMs?: number;
}>;

/**
 * The design's `crIssues`, in its order and words, plus the contract's own
 * limits the design leaves to the chain: a supply whose atoms fit in a u64,
 * a dollar bound, no zero address, a vesting bound, and a pool tier the venue
 * offers. An empty list means the form is complete.
 */
export function draftIssues(draft: CreateDraft, context: IssueContext): CreateIssue[] {
  const issues: CreateIssue[] = [];
  const add = (section: CreateSection, path: string, message: string) => issues.push({ section, path, message });
  const { fees, allowlist } = context;

  tokenAndLinks();
  scheduledStart();
  initialEligibility();
  liftEligibility();

  const tokenTotal = draft.buyers_bps + draft.pool_bps + fees.token_bps + sumBps(draft.token_recipients);
  if (!(draft.buyers_bps > 0)) add("split", "buyers_bps", "Buyers need a share");
  if (!(draft.pool_bps > 0)) add("split", "pool_bps", "The pool needs a share");
  if (tokenTotal !== BPS_DENOMINATOR) add("split", "split_total", `The shares make ${pctText(tokenTotal)}, not 100%`);
  recipients(draft.token_recipients, "token_recipients", "split");
  if (BPS_DENOMINATOR - fees.raise_bps - sumBps(draft.raise_recipients) <= 0) add("rsplit", "rsplit_total", "Leave part of the raise for the pool");
  recipients(draft.raise_recipients, "raise_recipients", "rsplit");

  const tiers = venueTiers(draft.venue);
  if (!tiers.some(([, fee]) => fee === draft.pool_fee)) add("raise", "pool_fee", `Pick a fee ${draft.venue === "cetus" ? "Cetus" : "Bluefin"} offers`);

  const feeTotal = draft.holders_bps + sumBps(draft.fee_recipients);
  if (feeTotal !== BPS_DENOMINATOR) add("fees", "fee_total", `The shares make ${pctText(feeTotal)}, not 100%`);
  recipients(draft.fee_recipients, "fee_recipients", "fees");
  validateVesting(draft.buyer_vesting, "buyer_vesting.vest", "split");
  return issues;

  function tokenIdentity() {
    if (!draft.name.trim()) add("token", "name", "Add a name");
    else if (isReservedCoinIdentity(draft.name)) add("token", "name", "This name is reserved for an existing coin. Choose another name.");
    if (!draft.symbol) add("token", "symbol", "Add a ticker");
    else if (isReservedCoinIdentity(draft.symbol)) add("token", "symbol", "This ticker is reserved for an existing coin. Choose another ticker.");
    else if (!/^[A-Z0-9]{2,10}$/.test(draft.symbol)) add("token", "symbol", "Use 2 to 10 letters or digits");
  }

  function tokenAndLinks() {
    tokenIdentity();
    if (!(draft.supply >= 1)) add("token", "supply", "Set a supply");
    if (!CREATE_DECIMALS.some((decimals) => decimals === draft.decimals)) add("token", "decimals", "Choose 6 or 9 decimals");
    else if (draft.supply > createMaxSupply(draft.decimals)) add("token", "supply", `Use at most ${count(createMaxSupply(draft.decimals))} tokens`);

    // R3-25: every link is optional; a wrong one is named in its own section.
    for (const [key, message] of LINK_CHECKS) if (!normalizeSaleLink(draft[key]).ok) add("links", key, message);
    if (!normalizeXHandle(draft.x_handle).ok) add("links", "x_handle", "X handles are up to 15 letters, digits or _");
    if (!normalizeTelegram(draft.telegram).ok) add("links", "telegram", "Telegram names are 5 to 32 letters, digits or _");
    if (!(draft.target > 0)) add("raise", "target", "Set a target");
    else if (draft.target > CREATE_MAX_USD) add("raise", "target", draftQuote(draft).symbol === "SUI" ? "Use at most 10B SUI" : "Use at most $10B");

  }

  function scheduledStart() {
    const { nowMs } = context;
    if (draft.start_ms === null || nowMs === undefined) return;
    if (draft.start_ms <= nowMs) add("raise", "start_ms", "Pick a time from now on");
    else if (draft.start_ms - nowMs > CREATE_START_MAX_AHEAD_MS) add("raise", "start_ms", `Open within ${CREATE_START_MAX_AHEAD_MS / 86_400_000} days`);
  }

  function initialEligibility() {
    if (draft.eligibility === "open") {
      if (!(draft.wallet_cap > 0)) add("join", "wallet_cap", "Set a limit per wallet");
      if (!(draft.min_commitment > 0)) add("join", "min_commitment", "Set a minimum");
      else if (draft.min_commitment > draft.wallet_cap) add("join", "min_commitment", "The minimum is above the limit per wallet");
      if (!(draft.max_wallets >= 1 && draft.max_wallets <= CREATE_MAX_WALLETS)) add("join", "max_wallets", `Allow 1 to ${count(CREATE_MAX_WALLETS)} wallets`);
      else if (draft.min_commitment > 0 && draft.target > 0 && draft.min_commitment * draft.max_wallets < draft.target) {
        add("join", "reach", `At the minimum, ${count(draft.max_wallets)} wallets raise only ${draftShort(draft, draft.min_commitment * draft.max_wallets)}`);
      }
    } else if (!draft.allowlist_id || !allowlist) add("join", "allowlist", "Upload the allowlist");
    // R3-42: a list's caps are in the coin it was uploaded for; a draft that now raises another coin needs a new one.
    else if (!allowlistFitsQuote(allowlist.quote_type, draft.quote_type)) add("join", "allowlist", `Upload the allowlist again, in ${draftQuote(draft).symbol}`);

  }

  function liftEligibility() {
    if (draft.lift && draft.lift_access === "anyone") {
      const { bound, slots } = liftSlots(draft, allowlist);
      const least = Math.max(1, bound);
      if (!(draft.lift_max_wallets >= least && draft.lift_max_wallets <= CREATE_MAX_WALLETS)) {
        add("join", "lift_max_wallets", `Allow at least ${count(least)} wallets, as many as before`);
      } else if (!(draft.lift_min > 0)) add("join", "lift_min", "Set a minimum");
      else if (draft.target > 0 && draft.lift_min * slots < draft.target) {
        add("join", "lift_reach", `At the minimum, the open slots raise only ${draftShort(draft, draft.lift_min * slots)}`);
      }
    }

  }

  function recipientAddressIssue(address: string, label: string, name: string, whose: string, seen: ReadonlySet<string>): string | null {
    if (!isWholeSuiAddressInput(address)) return address ? `${whose} address isn't a Sui address` : `Add ${label ? whose : "a"} Sui address`;
    else if (ZERO_ADDRESS.test(address)) return `${whose} address can't be zero`;
    else if (seen.has(address)) return `${name} repeats another address`;
    return null;
  }

  function validateVesting(row: CreateDraft["buyer_vesting"], path: string, section: CreateSection) {
    if (row.vest) {
      if (!VESTING_UNITS.includes(row.duration_unit) || !VESTING_UNITS.includes(row.cliff_unit)) add(section, path, "Choose a vesting unit");
      else if (!Number.isSafeInteger(row.duration) || !(row.duration > 0)) add(section, path, "Set how long it vests");
      else if (!Number.isSafeInteger(row.cliff) || row.cliff < 0) add(section, path, "Set a cliff of zero or more");
      else if (vestingDurationMs(row.cliff, row.cliff_unit) > vestingDurationMs(row.duration, row.duration_unit)) add(section, path, "The cliff is longer than the vesting");
      else if (vestingDurationMs(row.duration, row.duration_unit) > MAX_VESTING_DURATION_MS) add(section, path, "The vesting duration exceeds the contract's limit");
    }
  }

  function recipients(list: readonly (CreateRecipient | CreateFeeRecipient)[], key: string, section: CreateSection) {
    const seen = new Set<string>();
    list.forEach((row, index) => {
      const self = "self" in row && row.self;
      // OA-14: the creator's own fee row cannot be removed, so a 0% share means "nothing for me", not an error.
      if (self) return;
      const label = row.label.trim();
      const name = label || "Each recipient";
      const address = row.address.trim().toLowerCase();
      const whose = `${name}'s`;
      const addressIssue = recipientAddressIssue(address, label, name, whose, seen);
      if (addressIssue !== null) add(section, `${key}.${index}.address`, addressIssue);
      seen.add(address);
      if (!(row.bps > 0)) add(section, `${key}.${index}.bps`, `Give ${label || "it"} a share, or remove it`);
      if ("vest" in row) validateVesting(row, `${key}.${index}.vest`, section);
    });
  }
}

/** The design's button line: `3 to fix before publishing`, or `Review and publish`. */
export function reviewButtonLabel(issueCount: number): string {
  return issueCount ? `${issueCount} to fix before publishing` : "Review and publish";
}

// ---- the saved shape ----

export class DraftShapeError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`Invalid draft field: ${field}`);
    this.name = "DraftShapeError";
    this.field = field;
  }
}

/** A typed share may exceed 100% while the form is being filled; the totals then say so. */
const BPS_LIMIT = 100 * BPS_DENOMINATOR;
const OPTIONAL_KEYS: readonly string[] = CREATE_DRAFT_OPTIONAL_KEYS;
const KEYS = (Object.keys(blankDraft()) as (keyof CreateDraft)[]).filter((key) => !OPTIONAL_KEYS.includes(key));
const RECIPIENT_KEYS = ["label", "address", "bps", "vest", "cliff", "duration"] as const;
const RECIPIENT_UNIT_KEYS = ["cliff_unit", "duration_unit"] as const;
const FEE_RECIPIENT_KEYS = ["self", "label", "address", "bps"] as const;

function draftField<Schema extends z.ZodType>(schema: Schema, value: unknown, field: string): z.output<Schema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new DraftShapeError(field);
  return parsed.data;
}

/** Exactly `keys`, plus any of `optional`; anything else is a shape error. */
function record(value: unknown, keys: readonly string[], field: string, optional: readonly string[] = []): Record<string, unknown> {
  const shape = Object.fromEntries([
    ...keys.map((key) => [key, z.unknown().nonoptional()]),
    ...optional.map((key) => [key, z.unknown().optional()]),
  ]);
  return draftField(z.strictObject(shape), value, field);
}

/** An optional draft field: absent is `fallback`, else `read`. */
function optionalOf<T>(raw: Record<string, unknown>, key: string, fallback: T, read: (value: unknown) => T): T {
  return Object.hasOwn(raw, key) ? read(raw[key]) : fallback;
}

function text(value: unknown, max: number, field: string): string {
  return draftField(z.string().refine((text) => [...text].length <= max && !/[\u0000-\u001f\u007f]/.test(text)), value, field);
}

function integer(value: unknown, min: number, max: number, field: string): number {
  return draftField(z.number().int().min(min).max(max), value, field);
}

/**
 * Dollars: finite, from 0 to 1,000 times `CREATE_MAX_USD` (so its USDC atoms
 * stay inside a u64; `draftIssues` refuses a target above the bound), with at
 * most two decimals.
 */
const draftAmountSchema = z.number().min(0).max(CREATE_MAX_USD * 1_000);
const draftDollarsSchema = draftAmountSchema.refine((value) => Number(value.toFixed(2)) === value);

function dollars(value: unknown, field: string): number {
  return draftField(draftDollarsSchema, value, field);
}

function bool(value: unknown, field: string): boolean {
  return draftField(z.boolean(), value, field);
}

function oneOf<const T extends readonly (string | number)[]>(value: unknown, options: T, field: string): T[number] {
  return draftField(z.literal(options), value, field);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function recipientOf(value: unknown, field: string): CreateRecipient {
  const row = record(value, RECIPIENT_KEYS, field, RECIPIENT_UNIT_KEYS);
  const cliffUnit = optionalOf(row, "cliff_unit", "months" as const, (v) => oneOf(v, VESTING_UNITS, `${field}.cliff_unit`));
  const durationUnit = optionalOf(row, "duration_unit", "months" as const, (v) => oneOf(v, VESTING_UNITS, `${field}.duration_unit`));
  return {
    label: text(row.label, CREATE_LABEL_MAX, `${field}.label`),
    address: text(row.address, 66, `${field}.address`),
    bps: integer(row.bps, 0, BPS_LIMIT, `${field}.bps`),
    vest: bool(row.vest, `${field}.vest`),
    cliff: integer(row.cliff, 0, Number.MAX_SAFE_INTEGER, `${field}.cliff`),
    duration: integer(row.duration, 0, Number.MAX_SAFE_INTEGER, `${field}.duration`),
    cliff_unit: cliffUnit,
    duration_unit: durationUnit,
  };
}

function feeRecipientOf(value: unknown, field: string, index: number): CreateFeeRecipient {
  const row = record(value, FEE_RECIPIENT_KEYS, field);
  const self = bool(row.self, `${field}.self`);
  // The creator's row is the first and the only one.
  if (self !== (index === 0)) throw new DraftShapeError(`${field}.self`);
  return {
    self,
    label: self ? "You" : text(row.label, CREATE_LABEL_MAX, `${field}.label`),
    address: self ? "" : text(row.address, 66, `${field}.address`),
    bps: integer(row.bps, 0, BPS_LIMIT, `${field}.bps`),
  };
}

function list<T>(value: unknown, max: number, field: string, item: (value: unknown, field: string, index: number) => T): T[] {
  return draftField(z.array(z.unknown()).max(max), value, field)
    .map((entry, index) => item(entry, `${field}.${index}`, index));
}

/**
 * Reads a saved draft strictly: exactly the draft's keys, each of its type
 * and within its bound, so a stored draft always converts exactly to the
 * contract's arguments. What is merely unfinished (an empty name, a wrong
 * total, a half-typed address) is not a shape error; `draftIssues` lists it.
 */
export function parseDraft(value: unknown): CreateDraft {
  const raw = record(value, KEYS, "draft", OPTIONAL_KEYS);
  const venue = oneOf(raw.venue, CREATE_VENUES, "venue");
  const fees = list(raw.fee_recipients, CREATE_MAX_FEE_RECIPIENTS, "fee_recipients", feeRecipientOf);
  if (fees.length === 0) throw new DraftShapeError("fee_recipients");
  const symbol = text(raw.symbol, CREATE_SYMBOL_MAX, "symbol");
  draftField(z.string().regex(/^[A-Z0-9]*$/), symbol, "symbol");
  const allowlistId = raw.allowlist_id;
  const parsedAllowlistId = draftField(z.string().regex(UUID).nullable(), allowlistId, "allowlist_id");
  const quoteType = optionalOf(raw, "quote_type", CREATE_QUOTE_TYPE, (quote) => oneOf(quote, CREATE_QUOTES.map((one) => one.quote_type), "quote_type"));
  const target = draftField(draftAmountSchema.refine((value) => Number(value.toFixed(presaleTargetDecimals(quoteType))) === value), raw.target, "target");
  return {
    name: text(raw.name, CREATE_NAME_MAX, "name"),
    symbol,
    tagline: text(raw.tagline, CREATE_TAGLINE_MAX, "tagline"),
    supply: integer(raw.supply, 0, Number.MAX_SAFE_INTEGER, "supply"),
    decimals: optionalOf(raw, "decimals", CREATE_TOKEN_DECIMALS, (decimals) => oneOf(decimals, CREATE_DECIMALS, "decimals")),
    burnable: bool(raw.burnable, "burnable"),
    target,
    days: oneOf(raw.days, CREATE_SALE_DAYS, "days"),
    launch_when_filled: optionalOf(raw, "launch_when_filled", false, (value) => bool(value, "launch_when_filled")),
    start_ms: optionalOf(raw, "start_ms", null, (value) => draftField(z.number().int().min(1).max(8_640_000_000_000_000).nullable(), value, "start_ms")),
    eligibility: oneOf(raw.eligibility, CREATE_ELIGIBILITY, "eligibility"),
    wallet_cap: dollars(raw.wallet_cap, "wallet_cap"),
    min_commitment: dollars(raw.min_commitment, "min_commitment"),
    max_wallets: integer(raw.max_wallets, 0, CREATE_MAX_WALLETS * 10, "max_wallets"),
    allowlist_id: parsedAllowlistId,
    lift: bool(raw.lift, "lift"),
    lift_hours: oneOf(raw.lift_hours, CREATE_LIFT_HOURS, "lift_hours"),
    lift_access: oneOf(raw.lift_access, CREATE_LIFT_ACCESS, "lift_access"),
    lift_max_wallets: integer(raw.lift_max_wallets, 0, CREATE_MAX_WALLETS * 10, "lift_max_wallets"),
    lift_min: dollars(raw.lift_min, "lift_min"),
    lift_hard_cap: bool(raw.lift_hard_cap, "lift_hard_cap"),
    buyers_bps: integer(raw.buyers_bps, 0, BPS_LIMIT, "buyers_bps"),
    buyer_vesting: optionalOf(raw, "buyer_vesting", blankDraft().buyer_vesting, (value) => {
      const row = record(value, ["vest", "cliff", "duration", "cliff_unit", "duration_unit"], "buyer_vesting");
      return {
        vest: bool(row.vest, "buyer_vesting.vest"),
        cliff: integer(row.cliff, 0, Number.MAX_SAFE_INTEGER, "buyer_vesting.cliff"),
        duration: integer(row.duration, 0, Number.MAX_SAFE_INTEGER, "buyer_vesting.duration"),
        cliff_unit: oneOf(row.cliff_unit, VESTING_UNITS, "buyer_vesting.cliff_unit"),
        duration_unit: oneOf(row.duration_unit, VESTING_UNITS, "buyer_vesting.duration_unit"),
      };
    }),
    pool_bps: integer(raw.pool_bps, 0, BPS_LIMIT, "pool_bps"),
    token_recipients: list(raw.token_recipients, CREATE_MAX_RECIPIENTS, "token_recipients", recipientOf),
    raise_recipients: list(raw.raise_recipients, CREATE_MAX_RECIPIENTS, "raise_recipients", recipientOf),
    venue,
    pool_fee: integer(raw.pool_fee, 1, 1_000_000, "pool_fee"),
    lp_days: oneOf(raw.lp_days, CREATE_LP_DAYS, "lp_days"),
    holders_bps: integer(raw.holders_bps, 0, BPS_LIMIT, "holders_bps"),
    fee_recipients: fees,
    // R3-25: optional on a save (an older page's draft), always stored. Only USDC is raised today (R3-42 adds SUI).
    // R3-42: USDC (the default) or SUI, the quotes Create raises; the server lists which the picker offers now.
    quote_type: quoteType,
    site: optionalOf(raw, "site", "", (site) => text(site, CREATE_LINK_MAX, "site")),
    // A pasted profile link or an `@` is kept as the bare handle, as the form reduces it on input.
    x_handle: optionalOf(raw, "x_handle", "", (handle) => bareXHandle(text(handle, CREATE_LINK_MAX, "x_handle")).slice(0, CREATE_HANDLE_MAX)),
    telegram: optionalOf(raw, "telegram", "", (name) => bareTelegram(text(name, CREATE_LINK_MAX, "telegram")).slice(0, CREATE_HANDLE_MAX)),
    docs_url: optionalOf(raw, "docs_url", "", (docs) => text(docs, CREATE_LINK_MAX, "docs_url")),
    audit_url: optionalOf(raw, "audit_url", "", (audit) => text(audit, CREATE_LINK_MAX, "audit_url")),
  };
}

/** Whether two drafts hold the same values (a retried save). */
export function sameDraft(a: CreateDraft, b: CreateDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

