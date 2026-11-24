import { qp, qty, quoteOf, readsInCoin, shortAddress } from "@blast/core/web/format.ts";
import { n, perWalletText, saleMoney } from "@blast/core/modules/presale/presentation.ts";
import type { SocialPresaleDetail } from "@blast/core/web/contracts/presales.ts";

import type { AllowlistLeaf } from "#web/components/social/commit/commit-client.ts";
import { allowlistLeafOf, quoteCoinOf } from "#web/components/social/commit/commit-view.ts";
import type { ApiResult } from "#web/components/social/social-api.ts";

type Sale = SocialPresaleDetail["presale"];

/**
 * What an upcoming sale's Blast box tells the viewer about buying in it
 * (approved 2026-11-20): on the whitelist and up to how much, not on it,
 * signed out of a whitelisted sale, open to everyone, still checking, or the
 * list could not be read.
 */
export type SaleAccess =
  | Readonly<{ kind: "listed"; wallet: string; cap: string; tokens: string | null }>
  | Readonly<{ kind: "not_listed"; wallet: string; publicFrom: number | null }>
  | Readonly<{ kind: "signed_out"; wallets: number | null; publicFrom: number | null }>
  | Readonly<{ kind: "open"; range: string | null; tokens: string | null }>
  | Readonly<{ kind: "checking" }>
  | Readonly<{ kind: "unknown"; wallet: string | null; code: string | null }>;

export type SaleAccessReads = Readonly<{
  viewer: "pending" | "signed_out" | "signed_in";
  /** The Blast wallet's address; undefined while it is read, its failure code (null when unknown) when there is none or it failed. */
  wallet: string | Readonly<{ failed: string | null }> | undefined;
  /** The wallet's allowlist leaf; undefined while it is read (or not asked yet). */
  leaf: ApiResult<AllowlistLeaf> | undefined;
}>;

/** The sale's presale price in its own coin (a SUI sale's in SUI, a USDC sale's in dollars), or null when it is not known. */
function presalePrice(sale: Sale): number | null {
  const price = n(readsInCoin(quoteOf(sale)) ? sale.presale_price_quote : sale.presale_price_usd);
  return price > 0 ? price : null;
}

/** An amount in the sale's coin, as whole coins, from its atoms (a SUI sale) or its dollars (a USDC sale). */
function inCoin(sale: Sale, usd: string | null, atoms: string | null): number | null {
  if (readsInCoin(quoteOf(sale))) return atoms === null ? null : n(atoms) / 10 ** sale.quote_decimals;
  return usd === null ? null : n(usd);
}

/** Keeps each amount on one line with its coin ("20,000 USDC"), so a narrow box breaks a range only at "to". */
const unbroken = (money: string) => money.replace(/(\d) /g, "$1\u00a0");

const tokensOf = (amount: number, price: number) => qty(Math.round(amount / price));

function listedTokens(sale: Sale, cap: number): string | null {
  const price = presalePrice(sale);
  const each = qp(quoteOf(sale), { usd: sale.presale_price_usd, quote: sale.presale_price_quote });
  return price === null || each === null ? null : `≈\u00a0${tokensOf(cap, price)}\u00a0${sale.symbol} at ${unbroken(each)} each`;
}

function openTokens(sale: Sale): string | null {
  const price = presalePrice(sale);
  const min = inCoin(sale, sale.min_commitment_usd, sale.min_commitment_atoms);
  const cap = inCoin(sale, sale.wallet_cap_usd, sale.wallet_cap_atoms);
  if (price === null || min === null) return null;
  return cap === null ? `≈\u00a0${tokensOf(min, price)}\u00a0${sale.symbol} or more` : `≈\u00a0${tokensOf(min, price)} to ${tokensOf(cap, price)}\u00a0${sale.symbol}`;
}

function openAccess(sale: Sale): SaleAccess {
  const range = perWalletText(sale);
  return range === "–" ? { kind: "open", range: null, tokens: null } : { kind: "open", range: unbroken(range), tokens: openTokens(sale) };
}

/** A read leaf: listed up to its cap, refused as not listed, or anything else (an error, an unreadable leaf) as not checkable, with its code. */
function leafAccess(sale: Sale, address: string, leaf: ApiResult<AllowlistLeaf>, publicFrom: number | null): SaleAccess {
  const wallet = shortAddress(address);
  if (leaf.status === "refused" && leaf.code === "not_eligible") return { kind: "not_listed", wallet, publicFrom };
  const quoteCoin = quoteCoinOf(sale.quote_symbol);
  if (leaf.status !== "ok") return { kind: "unknown", wallet, code: leaf.code ?? null };
  const parsed = quoteCoin ? allowlistLeafOf(leaf.body, address, quoteCoin, sale.quote_decimals) : null;
  if (!parsed) return { kind: "unknown", wallet, code: "invalid_response" };
  // A USDC sale's money reads from dollars (one per coin), a SUI sale's from its atoms.
  return { kind: "listed", wallet, cap: unbroken(saleMoney(sale, String(parsed.cap), leaf.body.wallet_cap)), tokens: listedTokens(sale, parsed.cap) };
}

/** The box's state from the sale and the viewer's reads. */
export function saleAccess(detail: SocialPresaleDetail, reads: SaleAccessReads): SaleAccess {
  const sale = detail.presale;
  if (!sale.allowlisted) return openAccess(sale);
  // A sale with a public window lets any wallet buy from that time, after the whitelist goes first.
  const publicFrom = detail.terms?.public_buy?.from_ms ?? null;
  if (reads.viewer === "signed_out") {
    const eligibility = detail.terms?.eligibility;
    return { kind: "signed_out", wallets: eligibility?.kind === "allowlisted" ? eligibility.wallets : null, publicFrom };
  }
  // A viewer still being read has no wallet read yet; the wallet, then its leaf, is "checking" until it lands.
  if (reads.wallet === undefined) return { kind: "checking" };
  if (typeof reads.wallet !== "string") return { kind: "unknown", wallet: null, code: reads.wallet.failed };
  return reads.leaf === undefined ? { kind: "checking" } : leafAccess(sale, reads.wallet, reads.leaf, publicFrom);
}
