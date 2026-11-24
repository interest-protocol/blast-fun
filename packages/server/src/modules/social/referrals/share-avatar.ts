import { xPhotoCandidates } from "@blast/core/lib/x-photo-url.ts";
import { fetchCoinLogo, type CoinLogoResult } from "@blast/server/modules/presale/receipts/logo.ts";

/**
 * The card needs 300px, but X photos are stored as 48px thumbnails, and some
 * exist only at 400px. Try the candidates in order, then the saved photo.
 * A transient failure stops the walk so the caller can retry.
 */
export async function fetchReferralAvatar(
  reference: string,
  fetchImage: (url: string) => Promise<CoinLogoResult> = fetchCoinLogo,
): Promise<CoinLogoResult> {
  const candidates = xPhotoCandidates(reference);
  let result: CoinLogoResult | undefined;
  for (const candidate of candidates) {
    result = await fetchImage(candidate);
    if (result.logo || result.transient) return result;
  }
  // Not an X photo, or no candidate answered: the saved photo is the last try.
  return candidates.includes(reference) && result ? result : fetchImage(reference);
}
