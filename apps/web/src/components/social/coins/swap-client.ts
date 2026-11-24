import { financialCoinTypeSchema } from "@blast/core/web/contracts/financial-wire.ts";
import { isRecord } from "../social-api.ts";
import { socialTradeCoinSchema, socialTradeCoinPageSchema } from "@blast/core/web/contracts/trades.ts";
import { PublicError, responseError, responseDiagnostic } from "#web/lib/errors.ts";
import { gatedFetch } from "#web/lib/api-gate-client.ts";
import { socialTradeCoinsPath, type SocialTradeCoin, type SocialTradeCoinPage } from "@blast/core/web/contracts/trades.ts";
import { PRESALE_PHASES } from "@blast/core/web/contracts/presales.ts";
import type { WalletCoinView } from "./coin-model";
import { tradableCoinView } from "./swap-model";
import { isValidStructTag } from "@mysten/sui/utils";
import { readVisiblePage, withoutTestTradeCoins } from "#web/lib/test-launches.ts";
import { readSaleCoins } from "../coin-home/home-client.ts";

/**
 * The coins sheet's picker read (social feed R3-33): `GET
 * /api/social/trades/coins`, public and CDN-cached, so it goes without
 * credentials (like the presales list). A failure reads as null: the picker
 * still lists the coins the wallet holds.
 */

const PRICE = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

function isTradeCoin(value: unknown): value is SocialTradeCoin {
  return socialTradeCoinSchema.safeParse(value).success;
}

/** Whether `value` is the coins route's page (every coin well-formed). */
export function isTradeCoinPage(value: unknown): value is SocialTradeCoinPage {
  return socialTradeCoinPageSchema.safeParse(value).success;
}

/** Public sale metadata supplies a coin even when the wallet does not hold it. */
export function presaleCoinView(value: unknown, key: string): WalletCoinView | null {
  if (!isRecord(value) || !isRecord(value.presale)) return null;
  const sale = value.presale;
  const coin = { coin_type: sale.sale_token, symbol: sale.symbol, name: sale.name, decimals: sale.sale_decimals, icon_url: sale.icon_url === "" ? null : sale.icon_url, usd_price: sale.price_usd, presale_id: sale.presale_id };
  if (!isTradeCoin(coin) || coin.presale_id !== key || !PRESALE_PHASES.some((phase) => phase === sale.phase)) return null;
  return {
    ...tradableCoinView(coin),
    presale: {
      presaleId: key,
      venue: typeof sale.venue === "string" ? sale.venue : "",
      trading: sale.phase === "trading",
      ...(sale.phase === "open" ? { inPresale: true } : {}),
      ...(typeof sale.quote_symbol === "string" && typeof sale.quote_type === "string" && financialCoinTypeSchema.safeParse(sale.quote_type).success
        ? { quoteSymbol: sale.quote_symbol, quoteType: sale.quote_type } : {}),
      multiple: typeof sale.multiple === "string" && PRICE.test(sale.multiple) ? Number(sale.multiple) : null,
    },
  };
}

export async function fetchTradeCoins(
  query: Readonly<{ q?: string | null; cursor?: string | null }>,
  signal?: AbortSignal,
  request: typeof fetch = gatedFetch,
): Promise<SocialTradeCoinPage> {
  let response: Response;
  try {
    response = await request(socialTradeCoinsPath(query), { credentials: "same-origin", signal });
  } catch {
    throw new PublicError("More coins could not load. Check your connection and try again.", { code: "network_unavailable" });
  }
  if (!response.ok) throw responseError(await response.json().catch(() => null), response);
  const body: unknown = await response.json().catch(() => null);
  if (!isTradeCoinPage(body)) throw new PublicError("More coins returned an unreadable response. Try again.", { ...responseDiagnostic(response), code: "invalid_response" });
  return body;
}

/**
 * A coin picker's page: `fetchTradeCoins` without test sale coins, reading on
 * while a page is only test coins. A complete coin type is an exact lookup and
 * stays unfiltered, like a direct link.
 */
export function fetchListedTradeCoins(
  query: Readonly<{ q?: string | null; cursor?: string | null }>,
  signal?: AbortSignal,
): Promise<SocialTradeCoinPage> {
  if (query.q && isValidStructTag(query.q.trim())) return fetchTradeCoins(query, signal);
  return readVisiblePage(
    query.cursor ?? null,
    (cursor) => fetchTradeCoins({ ...query, cursor }, signal),
    (page) => withoutTestTradeCoins(page, readSaleCoins),
    (page) => page.coins.length,
    (page) => page.next_cursor,
  );
}
