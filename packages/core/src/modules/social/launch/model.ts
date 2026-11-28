import { MIGRATOR_VENUES, type MigratorVenue as LaunchVenue } from "@blast/core/modules/launchpad-contract/venues.ts";
import { launchFeeSplit } from "../../launchpad-contract/fee-split.ts";
import type { FeeSplit } from "@interest-protocol/blast-sdk";
import { addProtocolAllocation, apportionMeme, deriveLaunchEconomics, previewBuy } from "@interest-protocol/blast-sdk/launchpad";
import { memeAtomicSupply } from "@interest-protocol/blast-sdk/launchpad/template";
import { z } from "zod";

import { createQuoteOf, CREATE_LOGO_MAX_BYTES, type CreateQuote } from "@blast/core/modules/social/contracts/create.ts";
import { cetusTiersForQuote, type CreateCetusTiers } from "@blast/core/modules/social/create/cetus-options.ts";
import { bluefinTierSupported, type BluefinCreateOptions } from "@blast/core/modules/social/create/bluefin-options.ts";
import { isWholeSuiAddressInput } from "@blast/core/lib/sui/ids.ts";
import { venueTiers } from "@blast/core/modules/social/create/model.ts";
import { bareTelegram, bareXHandle, normalizeSaleLink, normalizeSaleTagline, normalizeTelegram, normalizeXHandle } from "@blast/core/modules/social/sales/validate.ts";

/**
 * A bonding-curve launch draft (`/launch`): every input `launch_ticket::new`,
 * the venue adapter's `new`, the `LaunchInitializer` setters and the
 * pre-share buy take, in the units the creator types, plus the off-chain
 * details (cover, tagline, links) the coin page shows.
 *
 * What the contract fixes is not here: the 1B supply, Blast's allocation
 * (`LaunchConfig.protocol_allocation`) and its trade and pool fee shares.
 *
 * The creator chooses curve and pool shares independently. Blast's fixed
 * share is reserved, optional recipients use the remainder, and any unused
 * remainder is sent to 0xdead at graduation. None of the raise goes to recipients.
 */

export { MIGRATOR_VENUES as LAUNCH_VENUES, type LaunchVenue };

export type LaunchRecipient = Readonly<{ label: string; address: string; bps: number }>;

export type LaunchDraft = Readonly<{
  name: string;
  symbol: string;
  description: string;
  decimals: number;
  burnable: boolean;
  sell_burn_bps: number;
  quote_type: string;
  /** Whole Quote coins (`launch::set_virtual_quote`). */
  virtual_quote: number;
  /** Whole Quote coins (`launch::set_graduation_target`). */
  graduation_target: number;
  /** The curve's share of the supply (`AllocationPlan.curve_meme_bps`). */
  curve_bps: number;
  /** The pool's independently chosen share of the original supply. */
  pool_bps: number;
  /** Token-only recipients paid at graduation. */
  recipients: readonly LaunchRecipient[];
  venue: LaunchVenue;
  /** The pool fee in millionths; the tick spacing follows from the venue's tier. */
  pool_fee: number;
  creator_fee_bps: number;
  /** Blank or omitted sends creator fees to the publishing Blast account. */
  creator_x_handle?: string;
  holders_fee_bps: number;
  auto_lp_fee_bps: number;
  burn_fee_bps: number;
  fee_recipients: readonly LaunchRecipient[];
  /** Whole Quote coins the creator buys before anyone else; 0 for none. */
  first_buy: number;
  tagline: string;
  site: string;
  x_handle: string;
  telegram: string;
  docs_url: string;
  audit_url: string;
}>;

/**
 * What the deployed `LaunchConfig`, `RuntimeConfig` and `LpFeePolicy` fix,
 * as the server reads them; the draft's checks and figures use it.
 */
export type LaunchRules = Readonly<{
  meme_decimals: readonly number[];
  quote_fee_bps: number;
  meme_fee_bps: number;
  protocol_meme_bps: number;
  protocol_quote_bps: number;
  /** Mist, exact (`LaunchConfig.creation_fee`). */
  creation_fee: string;
  /** Blast's share of each curve trade fee (`RuntimeConfig.protocol_fee_share_bps`). */
  protocol_fee_share_bps: number;
  /** Blast's share of pool fees before the creator's split (`LpFeePolicy.default_shares`). */
  pool_fee_meme_bps: number;
  pool_fee_quote_bps: number;
  /** Admitted Quote types this app can format, normalized. */
  quotes: readonly string[];
  cetus_tiers: CreateCetusTiers | null;
  bluefin_options: BluefinCreateOptions;
}>;

export const LAUNCH_NAME_MAX = 128;
export const LAUNCH_SYMBOL_MAX = 32;
export const LAUNCH_DESCRIPTION_MAX = 1_024;
export const LAUNCH_LABEL_MAX = 40;
export const LAUNCH_LINK_MAX = 2_048;
export const LAUNCH_HANDLE_MAX = 64;
export const LAUNCH_MAX_RECIPIENTS = 16;
export const LAUNCH_DEAD_ADDRESS = `0x${"dead".padStart(64, "0")}`;
export const LAUNCH_MAX_SELL_BURN_BPS = 5_000;
/** Largest whole-coin amount a draft holds; every admitted Quote converts within u64. */
export const LAUNCH_MAX_AMOUNT = 1_000_000_000;
/** Decimal places a typed Quote amount keeps. */
export const LAUNCH_AMOUNT_DECIMALS = 4;
export const LAUNCH_LOGO_MAX_BYTES = CREATE_LOGO_MAX_BYTES;
const BPS = 10_000;

/**
 * ADR 0054's recommended lane with Blast's allocation folded in (Fable
 * review 2026-10-29): V = T = 8,000, the largest curve share whose pool
 * still opens at the curve's last price.
 */
export function blankLaunchDraft(quoteType: string): LaunchDraft {
  return {
    name: "",
    symbol: "",
    description: "",
    decimals: 9,
    burnable: true,
    sell_burn_bps: 0,
    quote_type: quoteType,
    virtual_quote: 8_000,
    graduation_target: 8_000,
    curve_bps: 7_823,
    pool_bps: 1_927,
    recipients: [],
    venue: "cetus",
    pool_fee: 10_000,
    creator_fee_bps: 5_000,
    holders_fee_bps: 5_000,
    auto_lp_fee_bps: 0,
    burn_fee_bps: 0,
    fee_recipients: [],
    first_buy: 0,
    tagline: "",
    site: "",
    x_handle: "",
    telegram: "",
    docs_url: "",
    audit_url: "",
  };
}

// ---- the token split ----

/** The share of the raise the pool receives: all of it but Blast's (recipients take none). */
export const poolQuoteBps = (rules: Pick<LaunchRules, "protocol_quote_bps">): number => BPS - rules.protocol_quote_bps;

export type LaunchSplit = Readonly<{
  curve_bps: number;
  pool_bps: number;
  /** Remainder sent to 0xdead at graduation, separate from unsold curve tokens. */
  unallocated_bps: number;
  allocated_bps: number;
  protocol_bps: number;
  /** Projected sale and unsold inventory, both shares of the original supply. */
  sold_bps: number;
  unsold_bps: number;
}>;

export const sumBps = (rows: readonly { bps: number }[]): number => rows.reduce((sum, row) => sum + (row.bps || 0), 0);

export function launchSplit(draft: LaunchDraft, rules: Pick<LaunchRules, "protocol_meme_bps" | "protocol_quote_bps">): LaunchSplit {
  const allocated = sumBps(draft.recipients);
  const available = BPS - rules.protocol_meme_bps;
  const v = draft.virtual_quote;
  const t = draft.graduation_target;
  const sold = v > 0 && t > 0 ? Math.round((draft.curve_bps * t) / (v + t)) : 0;
  return {
    curve_bps: draft.curve_bps,
    pool_bps: draft.pool_bps,
    unallocated_bps: Math.max(0, available - draft.curve_bps - draft.pool_bps - allocated),
    allocated_bps: allocated,
    protocol_bps: rules.protocol_meme_bps,
    sold_bps: sold,
    unsold_bps: Math.max(0, draft.curve_bps - sold),
  };
}

/** The automatic 0xdead allocation uses one of the contract's recipient slots. */
export function launchRecipientLimit(draft: LaunchDraft, rules: LaunchRules): number {
  return LAUNCH_MAX_RECIPIENTS - Number(launchSplit(draft, rules).unallocated_bps > 0);
}

// ---- issues ----

export const LAUNCH_SECTIONS = ["coin", "curve", "split", "pool", "fees", "details", "buy"] as const;
export type LaunchSection = (typeof LAUNCH_SECTIONS)[number];
export type LaunchIssue = Readonly<{ section: LaunchSection; path: string; message: string }>;

export type LaunchIssueContext = Readonly<{ rules: LaunchRules; logoUrl: string | null }>;

export function pct(bps: number): string {
  const value = bps / 100;
  return `${Number.isInteger(value) ? value : Number(value.toFixed(2))}%`;
}

/** The quote's symbol for messages and labels. */
export function quoteSymbol(quoteType: string): string {
  return createQuoteOf(quoteType)?.symbol ?? "the quote coin";
}

/** Whether the venue offers this quote at any tier, and the tiers it offers. */
export function launchVenueTiers(rules: Pick<LaunchRules, "cetus_tiers" | "bluefin_options">, venue: LaunchVenue, quoteType: string): readonly (readonly [number, number])[] {
  return venue === "cetus"
    ? cetusTiersForQuote(quoteType, rules.cetus_tiers)
    : venueTiers("bluefin").filter(([spacing, fee]) => bluefinTierSupported(rules.bluefin_options, spacing, fee));
}

const SYMBOL = /^[A-Z][A-Z0-9_]*$/;
/** A wallet the contract pays: a full address, never 0x0 (`errors::invalid_destination`). */
const payable = (address: string): boolean => isWholeSuiAddressInput(address) && !/^0x0{64}$/i.test(address);

/**
 * Everything left to fix before the launch can be published, in the form's
 * order. The server answers these on every read and refuses a publish plan
 * while any remain, so the page and the chain agree.
 */
type AddLaunchIssue = (section: LaunchSection, path: string, message: string) => void;

function validateLaunchCoin(draft: LaunchDraft, rules: LaunchRules, add: AddLaunchIssue, logoUrl: string | null): void {
  if (!logoUrl) add("coin", "logo", "Add a logo");
  if (!draft.name.trim()) add("coin", "name", "Add a name");
  if (!draft.symbol) add("coin", "symbol", "Add a ticker");
  else if (!SYMBOL.test(draft.symbol)) add("coin", "symbol", "Start the ticker with a letter; use letters, digits or _");
  if (!rules.meme_decimals.includes(draft.decimals)) add("coin", "decimals", `Decimals must be ${rules.meme_decimals.join(" or ")}`);
  if (draft.sell_burn_bps > LAUNCH_MAX_SELL_BURN_BPS) add("coin", "sell_burn_bps", "Sell burn can be at most 50%");

}

function validateLaunchCurve(draft: LaunchDraft, rules: LaunchRules, add: AddLaunchIssue): void {
  if (!rules.quotes.includes(draft.quote_type)) add("curve", "quote_type", "This coin can't be raised in right now. Pick another");
  if (!(draft.virtual_quote > 0)) add("curve", "virtual_quote", "Set the starting liquidity");
  if (!(draft.graduation_target > 0)) add("curve", "graduation_target", "Set the raise target");

}

function validateLaunchSplit(draft: LaunchDraft, rules: LaunchRules, add: AddLaunchIssue): void {
  const split = launchSplit(draft, rules);
  if (draft.curve_bps < 1) add("split", "curve_bps", "Put some of the supply on the curve");
  if (draft.pool_bps < 1) add("split", "pool_bps", "Put some of the supply in the liquidity pool");
  draft.recipients.forEach((row, index) => {
    if (!payable(row.address.trim())) add("split", `recipients.${index}.address`, `Add ${row.label.trim() || "the recipient"}'s wallet`);
    if (!(row.bps > 0)) add("split", `recipients.${index}.bps`, `Give ${row.label.trim() || "the recipient"} a share`);
  });
  const limit = launchRecipientLimit(draft, rules);
  if (draft.recipients.length > limit) add("split", "recipients", `At most ${limit} recipients while some supply is unused`);
  const excess = split.curve_bps + split.pool_bps + split.protocol_bps + split.allocated_bps - BPS;
  if (excess > 0) add("split", "recipients", `Allocations exceed 100% by ${pct(excess)}. Reduce the curve, pool or recipient shares`);
}

function validateLaunchVenue(draft: LaunchDraft, rules: LaunchRules, add: AddLaunchIssue): void {
  const tiers = launchVenueTiers(rules, draft.venue, draft.quote_type);
  if (tiers.length === 0) add("pool", "venue", `${draft.venue === "cetus" ? "Cetus" : "Bluefin"} does not support ${quoteSymbol(draft.quote_type)} for new launches. Choose another venue`);
  else if (!tiers.some(([, fee]) => fee === draft.pool_fee)) add("pool", "pool_fee", "Choose a pool fee this venue offers");

}

function validateLaunchFees(draft: LaunchDraft, rules: LaunchRules, add: AddLaunchIssue): void {
  if (draft.creator_x_handle && !normalizeXHandle(draft.creator_x_handle).ok) {
    add("fees", "creator_x_handle", "Enter a valid X handle");
  }
  const feeTotal = draft.creator_fee_bps + draft.holders_fee_bps + draft.auto_lp_fee_bps + draft.burn_fee_bps + sumBps(draft.fee_recipients);
  if (feeTotal !== BPS) add("fees", "fee_total", `Pool fee shares add up to ${pct(feeTotal)}; make them 100%`);
  if (draft.fee_recipients.length > LAUNCH_MAX_RECIPIENTS) add("fees", "fee_recipients", `At most ${LAUNCH_MAX_RECIPIENTS} fee recipients`);
  const seen = new Set<string>();
  draft.fee_recipients.forEach((row, index) => {
    const address = row.address.trim().toLowerCase();
    if (!payable(address)) add("fees", `fee_recipients.${index}.address`, `Add ${row.label.trim() || "the recipient"}'s wallet`);
    else if (seen.has(address)) add("fees", `fee_recipients.${index}.address`, "Each fee recipient needs its own wallet");
    seen.add(address);
    if (!(row.bps > 0)) add("fees", `fee_recipients.${index}.bps`, `Give ${row.label.trim() || "the recipient"} a share`);
  });

}

function validateLaunchDetails(draft: LaunchDraft, rules: LaunchRules, add: AddLaunchIssue): void {
  if (!normalizeSaleTagline(draft.tagline, 80).ok) add("details", "tagline", "Shorten the short description");
  for (const [key, message] of [["site", "Website isn't a web address"], ["docs_url", "Docs isn't a web address"], ["audit_url", "Audit report isn't a web address"]] as const) {
    if (!normalizeSaleLink(draft[key]).ok) add("details", key, message);
  }
  if (!normalizeXHandle(draft.x_handle).ok) add("details", "x_handle", "Use the X handle without the @");
  if (!normalizeTelegram(draft.telegram).ok) add("details", "telegram", "Add the group name after t.me/");

}

function validateLaunchBuy(draft: LaunchDraft, rules: LaunchRules, add: AddLaunchIssue, issues: readonly LaunchIssue[]): void {
  if (draft.first_buy > 0 && !issues.some((issue) => ["curve", "split", "pool", "coin"].includes(issue.section))) {
    try {
      if (firstBuyMemeOut(draft, rules) <= 0n) add("buy", "first_buy", "Increase the first buy so it receives at least one token unit");
    } catch {
      add("buy", "first_buy", "This first buy cannot execute. Adjust the amount");
    }
  }
  if (draft.first_buy < 0) add("buy", "first_buy", "The first buy can't be negative");
}

export function launchIssues(draft: LaunchDraft, context: LaunchIssueContext): LaunchIssue[] {
  const issues: LaunchIssue[] = [];
  const add: AddLaunchIssue = (section, path, message) => { issues.push({ section, path, message }); };
  validateLaunchCoin(draft, context.rules, add, context.logoUrl);
  validateLaunchCurve(draft, context.rules, add);
  validateLaunchSplit(draft, context.rules, add);
  validateLaunchVenue(draft, context.rules, add);
  validateLaunchFees(draft, context.rules, add);
  validateLaunchDetails(draft, context.rules, add);
  validateLaunchBuy(draft, context.rules, add, issues);
  return issues;
}

// ---- strict parsing ----

export class LaunchDraftShapeError extends Error {
  readonly field: string;
  constructor(field: string) {
    super(`Invalid launch draft field: ${field}`);
    this.field = field;
  }
}

const KEYS = Object.keys(blankLaunchDraft("")) as readonly (keyof LaunchDraft)[];

function field<T>(schema: z.ZodType<T>, value: unknown, name: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new LaunchDraftShapeError(name);
  return parsed.data;
}

const text = (value: unknown, max: number, name: string) => field(z.string().max(max), value, name);
const bps = (value: unknown, name: string) => field(z.number().int().min(0).max(BPS), value, name);
const amount = (value: unknown, name: string) => {
  const parsed = field(z.number().min(0).max(LAUNCH_MAX_AMOUNT), value, name);
  if (Number(parsed.toFixed(LAUNCH_AMOUNT_DECIMALS)) !== parsed) throw new LaunchDraftShapeError(name);
  return parsed;
};

function recipients(value: unknown, name: string): LaunchRecipient[] {
  return field(z.array(z.unknown()).max(LAUNCH_MAX_RECIPIENTS), value, name).map((entry, index) => {
    const row = field(z.strictObject({ label: z.unknown(), address: z.unknown(), bps: z.unknown() }), entry, `${name}.${index}`);
    return {
      label: text(row.label, LAUNCH_LABEL_MAX, `${name}.${index}.label`),
      address: text(row.address, 66, `${name}.${index}.address`),
      bps: bps(row.bps, `${name}.${index}.bps`),
    };
  });
}

/**
 * Reads a launch draft strictly: exactly its keys, each of its type and
 * bound, so a stored draft always converts exactly to the contract's
 * arguments. Unfinished values are not shape errors; `launchIssues` lists them.
 */
export function parseLaunchDraft(value: unknown): LaunchDraft {
  const raw = field(z.record(z.string(), z.unknown()), value, "draft");
  const keys = Object.keys(raw).filter((key) => key !== "creator_x_handle");
  if (keys.length !== KEYS.length || !KEYS.every((key) => Object.hasOwn(raw, key))) throw new LaunchDraftShapeError("draft");
  const creatorXHandle = Object.hasOwn(raw, "creator_x_handle")
    ? bareXHandle(text(raw.creator_x_handle, LAUNCH_HANDLE_MAX, "creator_x_handle"))
    : "";
  const symbol = text(raw.symbol, LAUNCH_SYMBOL_MAX, "symbol");
  field(z.string().regex(/^[A-Z0-9_]*$/), symbol, "symbol");
  return {
    name: text(raw.name, LAUNCH_NAME_MAX, "name"),
    symbol,
    description: text(raw.description, LAUNCH_DESCRIPTION_MAX, "description"),
    decimals: field(z.number().int().min(0).max(18), raw.decimals, "decimals"),
    burnable: field(z.boolean(), raw.burnable, "burnable"),
    sell_burn_bps: field(z.number().int().min(0).max(LAUNCH_MAX_SELL_BURN_BPS), raw.sell_burn_bps, "sell_burn_bps"),
    quote_type: field(z.string().max(512), raw.quote_type, "quote_type"),
    virtual_quote: amount(raw.virtual_quote, "virtual_quote"),
    graduation_target: amount(raw.graduation_target, "graduation_target"),
    curve_bps: bps(raw.curve_bps, "curve_bps"),
    pool_bps: bps(raw.pool_bps, "pool_bps"),
    recipients: recipients(raw.recipients, "recipients"),
    venue: field(z.enum(MIGRATOR_VENUES), raw.venue, "venue"),
    pool_fee: field(z.number().int().min(1).max(1_000_000), raw.pool_fee, "pool_fee"),
    creator_fee_bps: bps(raw.creator_fee_bps, "creator_fee_bps"),
    ...(creatorXHandle ? { creator_x_handle: creatorXHandle } : {}),
    holders_fee_bps: bps(raw.holders_fee_bps, "holders_fee_bps"),
    auto_lp_fee_bps: bps(raw.auto_lp_fee_bps, "auto_lp_fee_bps"),
    burn_fee_bps: bps(raw.burn_fee_bps, "burn_fee_bps"),
    fee_recipients: recipients(raw.fee_recipients, "fee_recipients"),
    first_buy: amount(raw.first_buy, "first_buy"),
    tagline: text(raw.tagline, 160, "tagline"),
    site: text(raw.site, LAUNCH_LINK_MAX, "site"),
    x_handle: bareXHandle(text(raw.x_handle, LAUNCH_LINK_MAX, "x_handle")).slice(0, LAUNCH_HANDLE_MAX),
    telegram: bareTelegram(text(raw.telegram, LAUNCH_LINK_MAX, "telegram")).slice(0, LAUNCH_HANDLE_MAX),
    docs_url: text(raw.docs_url, LAUNCH_LINK_MAX, "docs_url"),
    audit_url: text(raw.audit_url, LAUNCH_LINK_MAX, "audit_url"),
  };
}

/** Old saved drafts keep their former pool allocation; new API writes stay strict. */
export function parseStoredLaunchDraft(value: unknown, rules: Pick<LaunchRules, "protocol_meme_bps">): LaunchDraft {
  const raw = field(z.record(z.string(), z.unknown()), value, "draft");
  if (Object.hasOwn(raw, "pool_bps")) return parseLaunchDraft(raw);
  const legacy = parseLaunchDraft({ ...raw, pool_bps: 0 });
  return parseLaunchDraft({
    ...legacy,
    pool_bps: Math.max(0, BPS - rules.protocol_meme_bps - legacy.curve_bps - sumBps(legacy.recipients)),
  });
}

export function sameLaunchDraft(a: LaunchDraft, b: LaunchDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---- conversion to the contract's arguments ----

/** Whole coins (at most `LAUNCH_AMOUNT_DECIMALS` places) as atomic units of a coin with `decimals`. */
export function toAtomic(value: number, decimals: number): bigint {
  const [whole, fraction = ""] = value.toFixed(LAUNCH_AMOUNT_DECIMALS).split(".");
  const scaled = BigInt(whole!) * 10n ** BigInt(decimals);
  const places = Math.min(decimals, LAUNCH_AMOUNT_DECIMALS);
  const kept = fraction.slice(0, places).padEnd(places, "0");
  return scaled + (places > 0 ? BigInt(kept) * 10n ** BigInt(decimals - places) : 0n);
}

/** The quote a draft raises in, or null for one this app does not format. */
export function launchQuote(draft: Pick<LaunchDraft, "quote_type">): CreateQuote | null {
  return createQuoteOf(draft.quote_type);
}

export type LaunchArguments = Readonly<{
  virtualQuote: bigint;
  graduationTarget: bigint;
  allocationPlan: Readonly<{ curveMemeBps: bigint; lpMemeBps: bigint; lpQuoteBps: bigint; recipients: { recipient: { destination: string; vestingTerms: null }; memeBps: bigint; quoteBps: bigint }[] }>;
  lpFeeSplit: FeeSplit;
  tickSpacing: number;
  feeRate: bigint;
  firstBuy: bigint;
}>;

/** The SDK arguments a finished draft converts to; throws for a draft with issues. */
export function launchArguments(draft: LaunchDraft, rules: LaunchRules): LaunchArguments {
  const quote = launchQuote(draft);
  if (!quote) throw new Error("The draft's quote cannot be converted");
  const tier = launchVenueTiers(rules, draft.venue, draft.quote_type).find(([, fee]) => fee === draft.pool_fee);
  if (!tier) throw new Error("The draft's pool tier is not offered");
  return {
    virtualQuote: toAtomic(draft.virtual_quote, quote.decimals),
    graduationTarget: toAtomic(draft.graduation_target, quote.decimals),
    allocationPlan: launchAllocationPlan(draft, rules),
    lpFeeSplit: launchFeeSplit({
      creatorBps: BigInt(draft.creator_fee_bps),
      autoLpBps: BigInt(draft.auto_lp_fee_bps),
      rewardsBps: BigInt(draft.holders_fee_bps),
      burnBps: BigInt(draft.burn_fee_bps),
      recipients: draft.fee_recipients.map((row) => ({ destination: row.address.trim().toLowerCase(), bps: BigInt(row.bps) })),
    }),
    tickSpacing: tier[0],
    feeRate: BigInt(tier[1]),
    firstBuy: toAtomic(draft.first_buy, quote.decimals),
  };
}

function launchAllocationPlan(draft: LaunchDraft, rules: LaunchRules): LaunchArguments["allocationPlan"] {
  const split = launchSplit(draft, rules);
  const recipients = draft.recipients.map((row) => ({ recipient: { destination: row.address.trim().toLowerCase(), vestingTerms: null }, memeBps: BigInt(row.bps), quoteBps: 0n }));
  if (split.unallocated_bps > 0) recipients.push({ recipient: { destination: LAUNCH_DEAD_ADDRESS, vestingTerms: null }, memeBps: BigInt(split.unallocated_bps), quoteBps: 0n });
  return { curveMemeBps: BigInt(split.curve_bps), lpMemeBps: BigInt(split.pool_bps), lpQuoteBps: BigInt(poolQuoteBps(rules)), recipients };
}

// ---- figures ----

export type LaunchFigures = Readonly<{
  /** FDVs in whole Quote coins: at the first trade, at graduation on the curve, and as the pool opens. */
  opening: number;
  terminal: number;
  pool: number;
  /** Pool opening price expressed at the curve’s supply, for a like-for-like price comparison. */
  poolAtCurveSupply: number;
  /** What the pool opens with: whole Quote coins and whole tokens. */
  poolQuote: number;
  poolTokens: number;
}>;

/**
 * The launch's figures as the SDK derives them from the plan the draft
 * builds (`deriveLaunchEconomics`), or null while the draft can't build one.
 */
export function launchFigures(draft: LaunchDraft, rules: LaunchRules): LaunchFigures | null {
  const quote = launchQuote(draft);
  const split = launchSplit(draft, rules);
  if (!quote || !(draft.virtual_quote > 0) || !(draft.graduation_target > 0) || split.curve_bps < 1 || split.pool_bps < 1 || draft.recipients.some((row) => !(row.bps >= 0))) return null;
  try {
    const preview = { ...draft, recipients: draft.recipients.map((row, index) => ({ ...row, address: `0x${(index + 1).toString(16).padStart(64, "0")}` })) };
    const plan = addProtocolAllocation(launchAllocationPlan(preview, rules), { memeBps: BigInt(rules.protocol_meme_bps), quoteBps: BigInt(rules.protocol_quote_bps) });
    const atomicSupply = memeAtomicSupply(draft.decimals);
    const economics = deriveLaunchEconomics({
      atomicSupply,
      allocationPlan: plan,
      virtualQuote: toAtomic(draft.virtual_quote, quote.decimals),
      graduationTarget: toAtomic(draft.graduation_target, quote.decimals),
    });
    const poolSupply = draft.burnable ? atomicSupply - economics.terminalCurveMeme : atomicSupply;
    const coins = (atomic: bigint, decimals: number) => Number(atomic) / 10 ** decimals;
    return {
      opening: coins(economics.openingValuation, quote.decimals),
      terminal: coins(economics.curveTerminalValuation, quote.decimals),
      pool: coins((poolSupply * economics.liquidityQuote) / economics.liquidityMeme, quote.decimals),
      poolAtCurveSupply: coins(economics.dexOpeningValuation, quote.decimals),
      poolQuote: coins(economics.liquidityQuote, quote.decimals),
      poolTokens: coins(economics.liquidityMeme, draft.decimals),
    };
  } catch {
    return null;
  }
}

/**
 * The first buy's exact output in atomic tokens on the curve's starting
 * state, or 0 for none. Before `share` no one else can trade, so the
 * server passes it as the buy's minimum and the page shows it.
 */
export function firstBuyMemeOut(draft: LaunchDraft, rules: LaunchRules): bigint {
  const args = launchArguments(draft, rules);
  if (args.firstBuy === 0n) return 0n;
  const plan = addProtocolAllocation(args.allocationPlan, { memeBps: BigInt(rules.protocol_meme_bps), quoteBps: BigInt(rules.protocol_quote_bps) });
  return previewBuy({
    memeReserve: apportionMeme(plan, memeAtomicSupply(draft.decimals)).curve,
    realQuoteReserve: 0n,
    virtualQuote: args.virtualQuote,
    graduationTarget: args.graduationTarget,
    quoteFeeBps: BigInt(rules.quote_fee_bps),
    memeFeeBps: BigInt(rules.meme_fee_bps),
  }, args.firstBuy).memeOutNet;
}
