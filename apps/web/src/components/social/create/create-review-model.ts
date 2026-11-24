import { quoteDisplaySymbol } from "./quote-coins";
import type { CreateBuyerVesting, CreateDraft, CreateIssue, CreatePublishBlocker } from "@blast/core/web/contracts/create.ts";
import { VESTING_UNIT_LABEL } from "@blast/core/web/contracts/vesting.ts";
import { draftQuote, draftTerms, pctText } from "@blast/core/modules/social/create/model.ts";
import { normalizeSaleLink, normalizeTelegram, normalizeXHandle } from "@blast/core/modules/social/sales/validate.ts";
import { fieldNumber, ppmPct, utc } from "@blast/core/web/format.ts";

import { draftMoney, draftPrices, draftShort, draftTarget, premiumText } from "./create-money";
import { walletLabel } from "./create-field-model";
import type { CreateState } from "./create-store";

/**
 * R3-25: the review's `Links` rows (the design's `crLinkList`): each valid
 * link as it will be stored, in the form's order; blank and wrong ones are
 * left out (a wrong one is already an issue, so the review is not open).
 */
export function reviewLinks(draft: CreateDraft): readonly (readonly [string, string])[] {
  const value = (normalized: { ok: boolean; value?: string | null }) => (normalized.ok ? (normalized.value ?? null) : null);
  const x = value(normalizeXHandle(draft.x_handle));
  const telegram = value(normalizeTelegram(draft.telegram));
  const rows: (readonly [string, string | null])[] = [
    ["Website", value(normalizeSaleLink(draft.site))],
    ["X", x && `@${x}`],
    ["Telegram", telegram && `t.me/${telegram}`],
    ["Docs", value(normalizeSaleLink(draft.docs_url))],
    ["Audit report", value(normalizeSaleLink(draft.audit_url))],
  ];
  return rows.filter((row): row is readonly [string, string] => row[1] !== null);
}

/** "a, b and c". */
export const listed = (items: readonly string[]) => items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items[0] ?? "";

/**
 * The reason line under a disabled Launch or Publish (shared by both flows):
 * "Add a team wallet and a treasury wallet to publish.", "Fix the pool fees
 * to launch.". Null when nothing is missing and nothing needs fixing.
 */
export function blockedLine(missing: readonly string[], places: readonly string[], goal: string): string | null {
  const parts = [missing.length ? `add ${listed(missing)}` : "", places.length ? `fix ${listed(places)}` : ""].filter(Boolean);
  if (!parts.length) return null;
  const line = `${parts.join(" and ")} to ${goal}.`;
  return line[0]!.toUpperCase() + line.slice(1);
}

const CREATE_FIX_PLACE: Readonly<Record<CreateIssue["section"], string>> = {
  token: "the coin",
  links: "the links",
  launch: "the launch",
  raise: "the raise",
  join: "who can join",
  split: "the token split",
  rsplit: "the raise split",
  fees: "the trading fees",
};

const RECIPIENT_ADDRESS = /^(token_recipients|raise_recipients|fee_recipients)\.(\d+)\.address$/;

/** An issue that is only an empty field, named the way the reason line adds it ("a name", "a team wallet"); null for anything to fix. */
function missingItem(draft: CreateDraft, issue: CreateIssue): string | null {
  if (issue.path === "name") return draft.name.trim() ? null : "a name";
  if (issue.path === "symbol") return draft.symbol.trim() ? null : "a ticker";
  const match = RECIPIENT_ADDRESS.exec(issue.path);
  const row = match ? draft[match[1] as "token_recipients" | "raise_recipients" | "fee_recipients"][Number(match[2])] : undefined;
  if (!row || row.address.trim()) return null;
  const label = walletLabel(row.label.trim() || "recipient");
  return `${/^[aeiou]/i.test(label) ? "an" : "a"} ${label[0]!.toLowerCase()}${label.slice(1)}`;
}

/**
 * Why Publish is off, naming what is missing (empty review rows stay blank;
 * this line says what to add): "Add a team wallet and a treasury wallet to
 * publish.". Signed out it still names the gaps, beside "Sign in".
 */
export function createBlockedReason(state: CreateState, issues: readonly CreateIssue[]): string {
  const missing = new Set<string>();
  const places = new Set<string>();
  for (const issue of issues) {
    const item = missingItem(state.draft, issue);
    if (item) missing.add(item);
    else if (issue.path === "tagline") places.add("the short description");
    else places.add(CREATE_FIX_PLACE[issue.section]);
  }
  const line = blockedLine([...missing], [...places], "publish");
  if (line) return line;
  if (state.logoPreview !== null || state.coverPreview !== null || state.allowlistUploading) return "Wait for the uploads to finish.";
  return "Wait for your draft to finish saving.";
}

/**
 * The money sentence above Publish: publishing moves no coins, so the worst
 * case is the network fees, and who pays them; it also carries the one-way
 * door (the sale's terms lock), so that fact sits beside the button, not in a
 * card of its own. Null before the account says which wallet pays.
 */
export function publishCostSentence(networkFees: CreateState["networkFees"]): string | null {
  if (networkFees === "blast") return "Publishing moves no coins and locks the sale’s terms. Blast pays the network fees.";
  if (networkFees === "wallet") return "Publishing moves no coins and locks the sale’s terms. Your wallet pays the network fees.";
  return null;
}

/**
 * Why publishing is off, in the page's words (OA-13): one line for the
 * creator, whatever the reasons. `saved` adds that the draft is kept; the
 * paused sheet passes false, because its note under the steps says it once.
 */
export function publishOffLine(reasons: readonly CreatePublishBlocker[], saved = true): string {
  if (reasons.includes("presale_not_deployed") || reasons.includes("coin_template_missing")) {
    return `Publishing opens once the presale contract is live on Sui mainnet.${saved ? " Your draft is saved, so you can publish it from here then." : ""}`;
  }
  const kept = saved ? " Your draft is saved." : "";
  if (reasons.includes("quote_unavailable")) return `No allowed raise coin is available right now.${kept}`;
  if (reasons.includes("creation_policy")) return `Presale permissions couldn’t be read from Sui. Try again shortly.${kept}`;
  return `Publishing isn’t available for this draft yet.${kept}`;
}

/**
 * One row of a Review group: the term, its value, and the wallet or venue it
 * names. `ticker` follows the value and breaks only when it cannot fit whole; `detail` is a
 * quieter line under it.
 */
export type ReviewRow = Readonly<{ key: string; value: string; ticker?: string; detail?: string; address?: string; venue?: string }>;
export type ReviewGroup = Readonly<{ title: string; summary: string; sections: readonly CreateIssue["section"][]; rows: readonly ReviewRow[] }>;

/** The coin's name, ticker and logo show in Review's hero, so their issues open no group. */
const HERO_PATHS: ReadonlySet<string> = new Set(["name", "symbol", "logo"]);

/**
 * What a folded Review group's row says instead of its value (Launch and
 * presale alike): the required value left empty (`missing`, "Team wallet
 * missing"), else the first issue in its sections; "" when nothing is
 * wrong. More than one reads "Team wallet missing, 1 more".
 */
export function reviewAttention(issues: readonly Readonly<{ section: string; path: string; message: string }>[], sections: readonly string[], missing: readonly string[] = []): string {
  const empty = [...new Set(missing)].map((key) => `${key} missing`);
  const groupSections = new Set(sections);
  const notes = empty.length ? empty : [...new Set(issues.filter((issue) => groupSections.has(issue.section) && !HERO_PATHS.has(issue.path)).map((issue) => issue.message))];
  if (notes.length === 0) return "";
  return notes.length === 1 ? notes[0]! : `${notes[0]}, ${notes.length - 1} more`;
}

/** The Details row's one-line value: what was added, or that nothing was. */
export function detailsSummary(description: boolean, links: number): string {
  const parts = [description ? "Description" : null, links === 0 ? null : links === 1 ? "1 link" : `${links} links`].filter((part): part is string => part !== null);
  return parts.length ? parts.join(", ") : "None added";
}

const DAY = 86_400_000;
const LIFT_LABELS: Readonly<Record<number, string>> = { 1: "Last hour", 6: "Last 6 hours", 24: "Last day" };
const vests = (row: CreateBuyerVesting) => `Vests ${row.duration} ${VESTING_UNIT_LABEL[row.duration_unit]}${row.cliff ? `, ${row.cliff}-${VESTING_UNIT_LABEL[row.cliff_unit]} cliff` : ""}`;

type ReviewInput = Pick<CreateState, "draft" | "fees" | "nowMs" | "selfAddress"> & Readonly<{ allowlistWallets: number | null }>;

const named = (row: { label: string }) => row.label.trim() || "Recipient";
const days = (count: number) => (count === 1 ? "1 day" : `${count} days`);

function raiseRows({ draft, nowMs, allowlistWallets }: ReviewInput): readonly ReviewRow[] {
  // The window runs from the scheduled start, else from the publish.
  const closes = utc((draft.start_ms ?? nowMs) + draft.days * DAY);
  const open = draft.eligibility === "open";
  const stops = draft.launch_when_filled || draft.lift_hard_cap;
  return [
    { key: "Target", value: draftTarget(draft) },
    { key: "Opens", value: `${draft.start_ms === null ? "When you publish" : utc(draft.start_ms)} · ${days(draft.days)}` },
    { key: "Closes", value: draft.launch_when_filled ? `At the target, or by ${closes}` : closes },
    { key: "Who can join", value: open ? `Anyone, ${draftMoney(draft, draft.min_commitment)} to ${draftMoney(draft, draft.wallet_cap)} each` : `${(allowlistWallets ?? 0).toLocaleString("en-US")} wallets on your list` },
    ...(open ? [{ key: "Maximum participating wallets", value: draft.max_wallets.toLocaleString("en-US") }] : []),
    { key: "Lift limits near the end", value: draft.lift ? `${LIFT_LABELS[draft.lift_hours]}: no limits for ${draft.lift_access === "anyone" ? "anyone" : "the same wallets"}${stops ? ", stops at the target" : ""}` : "Off" },
  ];
}

/**
 * The token split in at most three shares, each as set (never rounded to
 * another number): the buyers' share, then the pool and everything else
 * (recipients and Blast) on a quieter line.
 */
function tokenRow(draft: CreateDraft, blastBps: number): ReviewRow {
  const rest = draft.token_recipients.reduce((sum, row) => sum + row.bps, 0) + blastBps;
  return { key: "Token", value: `${pctText(draft.buyers_bps)} to buyers`, detail: `${pctText(draft.pool_bps)} pool · ${pctText(rest)} ${draft.token_recipients.length ? "recipients and Blast" : "Blast"}` };
}

/** The shares, each vesting schedule, and every wallet a token or raise share is paid to (once each). */
function splitRows({ draft, fees }: ReviewInput): readonly ReviewRow[] {
  const terms = draftTerms(draft, fees);
  const wallets = new Map<string, ReviewRow>();
  for (const row of [...draft.token_recipients, ...draft.raise_recipients]) {
    const key = walletLabel(named(row));
    wallets.set(`${key}:${row.address}`, { key, value: "", address: row.address });
  }
  return [
    tokenRow(draft, fees.token_bps),
    { key: "Buyer vesting", value: draft.buyer_vesting.vest ? `${vests(draft.buyer_vesting)} · from each buyer’s claim` : "Off" },
    ...draft.token_recipients.filter((row) => row.vest).map((row) => ({ key: `${named(row)} vesting`, value: vests(row) })),
    { key: "Raise", value: [`${pctText(Math.max(0, terms.lpBps))} pool`, ...draft.raise_recipients.map((row) => `${pctText(row.bps)} ${named(row)}`), `${pctText(fees.raise_bps)} Blast`].join(" · ") },
    ...draft.raise_recipients.filter((row) => row.vest).map((row) => ({ key: `${named(row)} raise vesting`, value: vests(row) })),
    ...wallets.values(),
  ];
}

/** The launch's prices (each left out until the draft can make it), timing, pool and liquidity. */
function launchRows({ draft, fees }: ReviewInput): readonly ReviewRow[] {
  const terms = draftTerms(draft, fees);
  const premium = premiumText(terms.premium);
  const prices = draftPrices(draft, terms.price, terms.launch);
  return [
    ...(terms.price ? [{ key: "Presale price", value: prices.presale }] : []),
    ...(terms.price && terms.launch ? [{ key: "Launch price", value: `${prices.launch} · ${premium} versus presale` }] : []),
    ...(terms.fdv ? [{ key: "Launch FDV", value: draftShort(draft, terms.fdv) }] : []),
    { key: "Launch timing", value: draft.launch_when_filled ? "When target is reached" : "At scheduled end" },
    { key: "Pool", value: `${ppmPct(draft.pool_fee)} pool fee`, venue: draft.venue },
    { key: "Launch window", value: `${draft.lp_days} days after it closes` },
    { key: "Liquidity", value: `${fieldNumber(Math.floor(terms.poolTokens))} ${draft.symbol || "tokens"} + ${draftMoney(draft, terms.poolQuote)}` },
  ];
}

function feeRows({ draft, fees, selfAddress }: ReviewInput): readonly ReviewRow[] {
  const blast = fees.lp_fee_meme_bps === fees.lp_fee_quote_bps
    ? `${pctText(fees.lp_fee_quote_bps)} of total trading fees`
    : `${pctText(fees.lp_fee_meme_bps)} of token fees / ${pctText(fees.lp_fee_quote_bps)} of ${quoteDisplaySymbol(draftQuote(draft).symbol)} fees`;
  return [
    { key: "Blast", value: blast },
    { key: "Holders", value: `${pctText(draft.holders_bps)} of the rest · daily rewards` },
    ...draft.fee_recipients.map((row) => (row.self
      ? { key: "You", value: `${pctText(row.bps)} of the rest`, ...(selfAddress ? { address: selfAddress } : {}) }
      : { key: named(row), value: `${pctText(row.bps)} of the rest`, address: row.address })),
  ];
}

/**
 * A signing step's label: a verb and the ticker it acts on ("Publish" and
 * `MRDN` read "Publish $MRDN"), or the whole phrase while the coin has no
 * ticker. The one source for the review list, the signing sheet and its
 * errors, in Create and Launch alike.
 */
export type SignLabel = Readonly<{ text: string; ticker: string | null }>;

export const signLabelText = (label: SignLabel): string => (label.ticker ? `${label.text} $${label.ticker}` : label.text);

/** The presale's publishing steps: three signatures, then saving the coin's images and links (no signature). */
export const PRESALE_SIGN_STEPS = ["publish_coin", "register_currency", "create_presale", "finalize_coin"] as const;
export type PresaleSignStep = (typeof PRESALE_SIGN_STEPS)[number];

export function presaleSignLabel(step: PresaleSignStep, symbol: string): SignLabel {
  const ticker = symbol.trim() || null;
  switch (step) {
    case "publish_coin": return ticker ? { text: "Publish", ticker } : { text: "Publish the coin", ticker: null };
    case "register_currency": return { text: "Register the currency", ticker: null };
    case "create_presale": return { text: "Create the presale", ticker: null };
    case "finalize_coin": return { text: "Finalize the coin", ticker: null };
  }
}

/**
 * Review's groups (the CreateReview board): every term the presale locks
 * and every wallet a share is paid to. The stepper is the one way back to edit.
 */
export function reviewGroups(input: ReviewInput): readonly ReviewGroup[] {
  const { draft, fees } = input;
  const terms = draftTerms(draft, fees);
  const prices = draftPrices(draft, terms.price, terms.launch);
  const self = draft.fee_recipients.find((row) => row.self);
  const links = reviewLinks(draft);
  // The name and ticker are the hero above the groups, so no row repeats them.
  return [
    {
      title: "Coin",
      summary: `${draft.burnable ? "Burn only" : "Fixed supply"}, ${draft.decimals} decimals`,
      sections: ["token"],
      rows: [
        draft.symbol ? { key: "Total supply", value: fieldNumber(draft.supply), ticker: draft.symbol } : { key: "Total supply", value: `${fieldNumber(draft.supply)} tokens` },
        { key: "After launch", value: draft.burnable ? "Burn only" : "Fixed supply" },
        { key: "Decimals", value: String(draft.decimals) },
      ],
    },
    { title: "Raise", summary: `Target ${draftTarget(draft)}, ${days(draft.days)}`, sections: ["raise", "join"], rows: raiseRows(input) },
    { title: "Splits", summary: `Buyers ${pctText(draft.buyers_bps)}, pool ${pctText(draft.pool_bps)}`, sections: ["split", "rsplit"], rows: splitRows(input) },
    { title: "Launch", summary: terms.price && terms.launch ? `Opens at ${prices.launch}` : draft.launch_when_filled ? "When target is reached" : "At scheduled end", sections: ["launch"], rows: launchRows(input) },
    { title: "Trading fees", summary: `Holders ${pctText(draft.holders_bps)}${self ? `, you ${pctText(self.bps)}` : ""}`, sections: ["fees"], rows: feeRows(input) },
    {
      title: "Details",
      summary: detailsSummary(Boolean(draft.tagline.trim()), links.length),
      sections: ["links"],
      rows: [
        ...(draft.tagline.trim() ? [{ key: "Short description", value: draft.tagline.trim() }] : []),
        { key: "Links", value: links.map(([, value]) => value).join(" · ") },
      ],
    },
  ];
}
