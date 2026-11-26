import type { AllowlistProof } from "@interest-protocol/blast-sdk/presale";

import type { CommitFacts } from "./commit-kit";
import { exactDecimal } from "@blast/core/web/exact-amount.ts";
import { atomsValue, qm, qp, qs, qty, quoteOf, readsInCoin, timeLeft, usd, venueName } from "@blast/core/web/format.ts";
import { vestingDurationText } from "@blast/core/web/contracts/vesting.ts";
import { short } from "@blast/core/lib/compact-dollars.ts";
import type { SocialWallet } from "@blast/core/web/contracts/coins.ts";
import type { FeedItem } from "@blast/core/web/contracts/items.ts";
import { SOCIAL_ENTRY_ID_PATTERN } from "@blast/core/web/contracts/viewer-state.ts";
import type { PresalePhase, SocialPresaleDetail, SocialPresaleViewerEntry } from "@blast/core/web/contracts/presales.ts";
import type { CommitPayCoin, CommitSale, CommitViewer } from "@blast/core/modules/social/commit/quote.ts";

import { PRESALE_PAR_QUOTE_TYPES } from "@blast/core/modules/social/contracts/create.ts";
import { PORTFOLIO_PRICE_MAX_AGE_MS } from "@blast/core/modules/social/contracts/portfolio.ts";
import { SUI_COIN_TYPE, USDC_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";

/**
 * The commit and sale dialogs' view model (FEATURE-MAP §4 and §11): pure
 * functions from the reads the host already has to the values the panel needs.
 * Every number the panel works in is **whole coins of the sale's own quote
 * coin**, because that is what the chain counts the minimum, the wallet cap,
 * the raise and the allocation in. The reads give USD, so the conversion
 * happens once, here.
 */

/**
 * The part of `GET /api/social/presales/{presale_id}` the dialogs read. A full
 * `SocialPresaleDetail` is assignable to it, so the sale page can hand over
 * what it already has, and the dialog's own fetch validates exactly this and
 * nothing more — a runtime guard over the whole detail (momentum, backers,
 * theses, the activity list, the raise chart) would be a second copy of a
 * contract this ticket does not own.
 */
export type CommitSaleRead = Readonly<{
  quote_price?: SocialPresaleDetail["quote_price"];
  presale: Readonly<{
    presale_id: string;
    coin_type?: string;
    name: string;
    symbol: string;
    icon_url: string;
    phase: PresalePhase;
    venue: string;
    start_ms: number;
    end_ms: number;
    target_usd: string | null;
    raised_usd: string | null;
    fill_bps: number;
    participants: number;
    interested: number;
    multiple: string | null;
    quote_symbol: string;
    quote_type: string;
    /** R3-40: the quote's decimals and the sale's figures in quote atoms (a SUI sale reads and counts in SUI). */
    quote_decimals: number;
    target_atoms: string;
    raised_atoms: string;
    sale_token: string;
    sale_decimals: number;
    allowlisted: boolean;
    min_commitment_usd: string | null;
    wallet_cap_usd: string | null;
    min_commitment_atoms: string | null;
    wallet_cap_atoms: string | null;
  }>;
  terms: Readonly<{ eligible_uncapped_from_ms?: number; public_buy?: NonNullable<SocialPresaleDetail["terms"]>["public_buy"]; buyer_vesting?: NonNullable<SocialPresaleDetail["terms"]>["buyer_vesting"]; presale_price_usd: string | null; presale_price_quote: string | null; supply: Readonly<{ total: string }> }> | null;
  vesting: Readonly<{ start_ms: number; cliff_end_ms: number; end_ms: number }> | null;
}>;

/** A full detail is one of these: the assignment fails to compile if it drifts. */
export type DetailIsReadable = SocialPresaleDetail extends CommitSaleRead ? true : never;

const DECIMAL = /^-?(0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

/** A decimal string from a contract, or null. */
export function decimal(value: string | null | undefined): number | null {
  if (typeof value !== "string" || !DECIMAL.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A quote's display symbol; its exact payment type comes from the presale. */
export function quoteCoinOf(symbol: string): CommitPayCoin | null {
  const upper = symbol.toUpperCase();
  return upper || null;
}

/** The coin type of a pay coin, for the SDK's `quoteType`. */
export const COMMIT_COIN_TYPES: Readonly<Record<CommitPayCoin, string>> = Object.freeze({
  USDC: USDC_COIN_TYPE,
  SUI: SUI_COIN_TYPE,
});

/** Atoms per whole coin of each quote coin the product holds: USDC 6, SUI 9. */
export const COMMIT_COIN_DECIMALS: Readonly<Record<CommitPayCoin, number>> = Object.freeze({ USDC: 6, SUI: 9 });

const U64 = /^(0|[1-9][0-9]*)$/;

/**
 * The viewer's allowlist leaf (`GET /api/presale/presales/{id}/proof`) as the
 * panel and the transaction need it. The route answers the wallet cap as an
 * on-chain u64, in quote atoms, so the panel's cap is scaled to whole quote
 * coins here, once, and the transaction keeps the atoms and the proof exactly
 * as the route gave them: `commit_allowlisted` verifies the leaf against the
 * sale's root, so nothing in it may be rounded. Null for a leaf that is not
 * well formed, which the host treats as an unreadable list.
 */
export function allowlistLeafOf(
  leaf: Readonly<{ index: string; wallet_cap: string; proof: readonly string[] }>,
  wallet: string,
  quoteCoin: CommitPayCoin,
  decimals: number = COMMIT_COIN_DECIMALS[quoteCoin],
): Readonly<{ cap: number; proof: AllowlistProof }> | null {
  if (!U64.test(leaf.index) || !U64.test(leaf.wallet_cap) || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) return null;
  const walletCap = BigInt(leaf.wallet_cap);
  return {
    cap: atomsValue(walletCap, decimals) ?? 0,
    proof: { index: BigInt(leaf.index), wallet, walletCap, proof: [...leaf.proof] },
  };
}

/**
 * The sale, in its own quote coin and exact on-chain type.
 *
 * R3-41: every figure comes from the sale's own atoms and the view's decimals
 * (R3-40), never back from its dollars. Before, a SUI sale's minimum, cap,
 * raise and price were its dollar figures divided by today's SUI price — an
 * approximation of a number the chain holds exactly, and nothing at all
 * without a price, so the minimum vanished from a SUI sale's panel whenever
 * the price row was stale. The minimum the panel compares (`Minimum is 25 SUI`)
 * is now the chain's own `min_commitment`, with or without a price.
 */
export function publicBuyActive(detail: CommitSaleRead, nowMs: number): boolean {
  const window = detail.terms?.public_buy;
  return !!window && detail.presale.phase === "open" && window.from_ms <= nowMs && nowMs < detail.presale.end_ms;
}

function freshQuoteUsd(price: CommitSaleRead["quote_price"], nowMs: number): number | undefined {
  if (!price) return undefined;
  const age = nowMs - price.as_of_ms;
  const usd = decimal(price.usd_price);
  return 0 <= age && age <= PORTFOLIO_PRICE_MAX_AGE_MS && usd !== null && usd > 0 ? usd : undefined;
}

export function commitSaleOf(
  detail: CommitSaleRead,
  prices: Readonly<{ suiUsd: number | null }>,
  nowMs = Date.now(),
): CommitSale | null {
  const presale = detail.presale;
  const quoteCoin = quoteCoinOf(presale.quote_symbol);
  if (!quoteCoin) return null;
  void prices;
  const quoteUsd = freshQuoteUsd(detail.quote_price, nowMs);
  const publicBuy = publicBuyActive(detail, nowMs) ? detail.terms?.public_buy : undefined;
  const coins = (atoms: string | null | undefined): number | null => atomsValue(atoms, presale.quote_decimals);
  return {
    presaleId: presale.presale_id,
    name: presale.name,
    symbol: presale.symbol,
    lifecycle: presale.phase === "open" ? "open" : presale.phase,
    endMs: presale.end_ms,
    quoteCoin,
    quoteType: presale.quote_type,
    ...(quoteUsd === undefined ? {} : { quoteUsd }),
    quoteDecimals: presale.quote_decimals,
    minCommitment: publicBuy ? coins(publicBuy.min_atoms) : presale.allowlisted ? null : coins(presale.min_commitment_atoms),
    walletCap: publicBuy || presale.allowlisted ? null : coins(presale.wallet_cap_atoms),
    allowlisted: !publicBuy && presale.allowlisted,
    ...(detail.terms?.eligible_uncapped_from_ms === undefined ? {} : { eligibleUncappedFromMs: detail.terms.eligible_uncapped_from_ms }),
    ...(publicBuy ? {
      publicBuy: true,
      hardCapped: publicBuy.hard_cap_from_ms != null && publicBuy.hard_cap_from_ms <= nowMs,
      remainingAtoms: (BigInt(presale.target_atoms) - BigInt(presale.raised_atoms)).toString(),
    } : {}),
    raised: coins(presale.raised_atoms) ?? 0,
    target: coins(presale.target_atoms) ?? 0,
    presalePrice: decimal(detail.terms?.presale_price_quote ?? null),
  };
}

function refreshCommitQuote(facts: CommitFacts, nowMs: number): CommitFacts {
  const { sale, detail, wallet, viewer } = facts;
  if (!sale?.quoteType) return facts;
  const quoteUsd = freshQuoteUsd(detail.quote_price, nowMs);
  if (sale.quoteUsd === quoteUsd) return facts;

  const refreshedSale = { ...sale, quoteUsd };
  const walletPrice = walletCoin(wallet, sale.quoteType).usdPrice;
  return {
    ...facts,
    sale: refreshedSale,
    viewer: { ...viewer, quoteUsd: commitQuoteUsd(refreshedSale, { ...viewer, quoteUsd: walletPrice }) },
  };
}

/** Re-evaluate the cached price and eligibility as the hold or public window progresses. */
export function commitFactsAt(facts: CommitFacts, nowMs: number): CommitFacts;
export function commitFactsAt(facts: CommitFacts | null, nowMs: number): CommitFacts | null;
export function commitFactsAt(facts: CommitFacts | null, nowMs: number): CommitFacts | null {
  if (!facts) return null;
  facts = refreshCommitQuote(facts, nowMs);
  if (!facts.sale || !publicBuyActive(facts.detail, nowMs)) return facts;
  const hardCapFrom = facts.detail.terms?.public_buy?.hard_cap_from_ms;
  const hardCapped = hardCapFrom != null && hardCapFrom <= nowMs;
  if (facts.sale.publicBuy && facts.sale.hardCapped === hardCapped &&
      !facts.proof && !facts.viewer.allowlist && !facts.blockers.includes("allowlist_unavailable")) return facts;
  return {
    ...facts,
    sale: commitSaleOf(facts.detail, { suiUsd: facts.viewer.suiUsd }, nowMs),
    viewer: { ...facts.viewer, allowlist: null },
    proof: null,
    blockers: facts.blockers.filter((reason) => reason !== "allowlist_unavailable"),
  };
}

/** The coin's whole-coin balance in the Blast wallet, and its USD price. */
export function walletCoin(wallet: SocialWallet | null, coinType: string): Readonly<{ amount: number; usdPrice: number | null }> {
  const coin = wallet?.coins?.find((candidate) => candidate.coin_type === coinType);
  if (!coin || coin.decimals === null) return { amount: 0, usdPrice: null };
  return { amount: atomsValue(coin.atoms, coin.decimals) ?? 0, usdPrice: decimal(coin.usd_price) };
}

/**
 * What the viewer brings. `committed` is the signing wallet’s commitment in
 * the quote coin, and `allowlist` stays null until
 * the leaf has actually been read, so the panel never claims someone is off a
 * list it has not looked at.
 */
export function commitViewerOf(input: Readonly<{
  wallet: SocialWallet | null;
  sale: CommitSale | null;
  entry: SocialPresaleViewerEntry | null | undefined;
  allowlist: Readonly<{ on: boolean; cap: number | null }> | null;
}>): CommitViewer {
  const usdc = walletCoin(input.wallet, USDC_COIN_TYPE);
  const sui = walletCoin(input.wallet, SUI_COIN_TYPE);
  const sale = input.sale;
  const quote = sale?.quoteType ? walletCoin(input.wallet, sale.quoteType) : null;
  // R3-41: what the wallet already holds in the sale, in the sale's own coin from its atoms (no price needed).
  const atoms = input.entry?.mine?.claim_wallet_commitment_atoms;
  const committed = input.sale === null ? null : atomsValue(atoms, input.sale.quoteDecimals ?? COMMIT_COIN_DECIMALS[input.sale.quoteCoin]);
  return {
    usdc: usdc.amount,
    sui: sui.amount,
    suiUsd: sui.usdPrice,
    ...(sale && quote ? {
      quoteCoin: sale.quoteCoin,
      quoteBalance: quote.amount,
      quoteUsd: commitQuoteUsd(sale, { quoteCoin: sale.quoteCoin, quoteUsd: quote.usdPrice, suiUsd: sui.usdPrice }),
    } : {}),
    committed: committed ?? 0,
    allowlist: input.allowlist,
  };
}

/** USD per whole quote coin for both direct and swap-funded commitments. */
export function commitQuoteUsd(sale: CommitSale, viewer: Pick<CommitViewer, "quoteCoin" | "quoteUsd" | "suiUsd">): number | null {
  const quoteType = sale.quoteType ?? COMMIT_COIN_TYPES[sale.quoteCoin];
  if (PRESALE_PAR_QUOTE_TYPES.includes(quoteType)) return 1;
  const walletPrice = viewer.quoteCoin === sale.quoteCoin ? viewer.quoteUsd : null;
  return sale.quoteUsd ?? walletPrice ?? (quoteType === SUI_COIN_TYPE ? viewer.suiUsd : null);
}

/**
 * The post a sale page's URL credits (`?via=<entry_id>`, T-024), or null for
 * none or for anything that is not an entry id. Whether it credits anyone is
 * the route's call: it stores the source only if the entry is visible.
 */
export function viaEntryOf(search: string): string | null {
  const via = new URLSearchParams(search).get("via");
  return via !== null && SOCIAL_ENTRY_ID_PATTERN.test(via) ? via : null;
}

/** The dialog's accessible name, exactly as the reference labels it. */
export function commitDialogLabel(saleName: string): string {
  return `Blast into ${saleName}`;
}

/** The "Through <name>'s post" line's name: the source item's actor, when it is named and not the viewer's own. */
export function sourceThroughName(item: FeedItem | null, viewerCallsign: string | null): string | null {
  const actor = item?.actor;
  if (!actor || actor.type !== "account") return null;
  if (viewerCallsign !== null && actor.callsign === viewerCallsign) return null;
  // The reference takes the first word of the display name, and the callsign otherwise.
  return (actor.display_name ?? actor.callsign).split(" ")[0] ?? actor.callsign;
}

export type SaleFact = Readonly<{ label: string; value: string; note: string | null }>;

function buyerVestingFact(buyer: NonNullable<CommitSaleRead["terms"]>["buyer_vesting"]): SaleFact {
  if (buyer === undefined) return { label: "Buyer vesting", value: "Unavailable", note: "check the presale page" };
  if (buyer === null) return { label: "Buyer vesting", value: "None", note: "full allocation at claim" };
  return { label: "Buyer vesting", value: `Over ${vestingDurationText(Number(buyer.duration_ms))}`, note: `From your claim${buyer.cliff_ms !== "0" ? ` · ${vestingDurationText(Number(buyer.cliff_ms))} cliff` : ""}` };
}

/** The three fact tiles of §11, with the reference's own words and formats. */
export function saleFacts(detail: CommitSaleRead): readonly SaleFact[] {
  const quote = quoteOf(detail.presale);
  const price = decimal(detail.terms?.presale_price_usd ?? null);
  const supply = atomsValue(detail.terms?.supply.total ?? null, detail.presale.sale_decimals);
  // R3-40: a SUI sale's price and FDV read in SUI (`qp`, `qs`), the FDV exact from the price and the supply's atoms.
  const coinPrice = exactDecimal(detail.terms?.presale_price_quote ?? null);
  const total = detail.terms?.supply.total ?? null;
  const coinFdv = coinPrice === null || total === null || !/^(0|[1-9][0-9]*)$/.test(total)
    ? null
    : qs({ symbol: quote.symbol, decimals: coinPrice.scale + detail.presale.sale_decimals }, { usd: null, atoms: (coinPrice.n * BigInt(total)).toString() });
  const coin = readsInCoin(quote);
  const priceText = coin ? qp(quote, { usd: null, quote: detail.terms?.presale_price_quote ?? null }) : price === null ? null : usd(price, 6);
  const fdvText = coin ? coinFdv : price === null || supply === null ? null : short(price * supply);
  return [
    { label: "Presale price", value: priceText ?? "—", note: `per ${detail.presale.symbol}` },
    {
      label: "FDV at presale",
      value: fdvText ?? "—",
      note: supply === null ? null : `${qty(supply)} supply`,
    },
    buyerVestingFact(detail.terms?.buyer_vesting),
  ];
}

/**
 * The §11 line for a sale that is not taking commitments, in the reference's
 * own words per lifecycle. A `closed` sale (its end passed, the chain has not
 * settled it) has no line in the reference, which has no such phase: it gets
 * the honest one.
 */
export function saleDialogLine(detail: CommitSaleRead, nowMs: number): string {
  const sale = detail.presale;
  const target = decimal(sale.target_usd);
  const raised = decimal(sale.raised_usd);
  // R3-40: the target in the sale's own coin (`qm`): `Needs $400,000`, `Needs 100,000 SUI`.
  const needs = qm(quoteOf(sale), { usd: sale.target_usd, atoms: sale.target_atoms });
  switch (sale.phase) {
    case "pending":
      return `Needs ${needs ?? "its target"} to succeed. ${sale.interested.toLocaleString("en-US")} ${sale.interested === 1 ? "person is" : "people are"} following it.`;
    case "funded":
      return `Funded, ${target && raised ? (raised / target).toFixed(2) : "1.00"}× oversubscribed. Claims open when trading starts on ${venueName(sale.venue)}.`;
    case "trading": {
      const times = decimal(sale.multiple);
      return times === null
        ? `Trading on ${venueName(sale.venue)}.`
        : `Trading on ${venueName(sale.venue)} at ${times.toFixed(1)}× the presale price.`;
    }
    case "cancelled":
      return "The target was missed, so everyone can claim a full refund.";
    case "closed":
      return "It closed. Blast is settling it on Sui; claims open once it has.";
    default:
      return `Closes in ${timeLeft(Math.max(0, sale.end_ms - nowMs))}.`;
  }
}

/**
 * The footer link of the sale dialog, and *only* of the sale dialog: a quiet
 * `sheet-link` with a chevron next to a primary action (a pending sale's
 * "Notify me"), and a full-width line button when it stands alone.
 *
 * **This is the reference's rule, and it is the opposite of what
 * `FEATURE-MAP-R3.md` §11 and `R3-DELTA.md` §11 both say.** Driven in the
 * gate: a pending sale renders `a.sheet-link` and every other state renders
 * `a.btn.btn-line.btn-lg.btn-block`. The reference's own comment says why
 * ("next to a primary action it is a quiet link, as in the Blast dialog;
 * alone it is the button"). Recorded in the ticket as a documentation defect,
 * not resolved here: the gate wins (OA-23).
 */
export function saleFooterLinkStyle(phase: PresalePhase): "quiet" | "button" {
  return phase === "pending" ? "quiet" : "button";
}

