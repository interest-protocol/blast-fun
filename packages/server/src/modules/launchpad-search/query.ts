import { z } from "zod";
import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils";

import { normalizeSearchText, searchQuery } from "@blast/server/modules/launchpad-social/contracts.ts";
import { SOCIAL_LIMITS, type SocialLimits } from "@blast/core/modules/launchpad-social/limits.ts";

/**
 * A launchpad search as the reads use it: its text in search form and as a
 * prefix tsquery, and the exact identifier it is, if any. Browser-safe.
 */
export type SearchQuery = Readonly<{
  /** The query's search form (NFKC, lower case, single spaces): what the ticker and name tiers compare. */
  text: string;
  /** Every word as a required prefix: a PostgreSQL `simple` tsquery (launchpad-social `searchQuery`). */
  words: string;
  /** The canonical Sui address the query is: a launch ID, a pool ID or a wallet. */
  address: string | null;
  /** The coin type the query is, its address canonical. */
  coinType: string | null;
}>;

/** Only an explicit `0x` makes hex an identifier, so a word such as "face" stays text. */
const ADDRESS = /^0x[0-9a-fA-F]{1,64}$/;
const COIN_TYPE = /^(0x[0-9a-fA-F]{1,64})::([A-Za-z_][A-Za-z0-9_]*)::([A-Za-z_][A-Za-z0-9_]*)$/;

function canonicalAddress(value: string): string | null {
  if (!z.string().regex(ADDRESS).safeParse(value).success) return null;
  const address = normalizeSuiAddress(value);
  return isValidSuiAddress(address) ? address : null;
}

/**
 * Classifies a raw search. Its text is always searched; a `0x` address of
 * at most 64 hex digits is also an exact launch ID, pool ID or wallet, and
 * `0x<address>::<module>::<Name>` an exact coin type. No word, or over
 * `limits.searchQueryLength` characters, is a SocialQueryError (400) that
 * never echoes the query.
 */
export function parseSearchQuery(raw: string, limits: SocialLimits = SOCIAL_LIMITS): SearchQuery {
  const words = searchQuery(raw, limits);
  const trimmed = raw.trim();
  const coin = COIN_TYPE.exec(trimmed);
  const coinAddress = coin ? canonicalAddress(coin[1]) : null;
  return {
    text: normalizeSearchText(raw),
    words,
    address: canonicalAddress(trimmed),
    coinType: coin && coinAddress ? `${coinAddress}::${coin[2]}::${coin[3]}` : null,
  };
}
