import { z } from "zod";
import { PREFERRED_COINS } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { normalizeStructTag } from "@mysten/sui/utils";

import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { socialWalletBalanceSchema, socialWalletCoinSchema, type SocialWalletCoin } from "@blast/core/modules/social/contracts/coins.ts";
import { coinTypeName, wireIconUrl, wireText } from "@blast/core/modules/social/contracts/financial-wire.ts";
import { tradesInApp } from "@blast/core/modules/social/contracts/trades.ts";
import { presalePrices } from "@blast/server/modules/social/profiles/calls.ts";
import { readPresaleFacts } from "@blast/server/modules/social/profiles/presales.ts";
import { atomsToUsd, isFreshPrice, PORTFOLIO_COIN_TYPES, type PortfolioPrice } from "@blast/core/modules/social/portfolio/read.ts";
import { SHOWN_PRESALES } from "@blast/core/modules/social/read-model/chain-presales.ts";
import { readCoinMetadata } from "@blast/server/modules/social/portfolio/coin-metadata.ts";
import { TEST_SUI_COIN_TYPES } from "@blast/core/modules/social/contracts/create.ts";
import { TEST_SUI_LAUNCH_TYPES } from "@blast/server/modules/social/read-model/blast-launch-coins.ts";

type ListedCoinBalance = Readonly<{ coinType: string; balance: string }>;

/**
 * The fullnode read the coins sheet needs: one owner's balances, a page at a
 * time. `SuiGrpcClient.core` has this shape; tests pass a stub.
 */
export interface CoinsFullnode {
  listBalances(input: Readonly<{ owner: string; limit?: number; cursor?: string | null; signal?: AbortSignal }>): Promise<
    Readonly<{ balances: readonly ListedCoinBalance[]; hasNextPage: boolean; cursor: string | null }>
  >;
  getBalance(input: Readonly<{ owner: string; coinType: string; signal?: AbortSignal }>): Promise<Readonly<{ balance: Readonly<{ balance: string }> }>>;
}

/** How long one wallet read may take on the fullnode, all pages together. */
export const COINS_FULLNODE_TIMEOUT_MS = 4_000;
/** Balances per page; every page must finish within the wallet read's deadline. */
export const COINS_PAGE_SIZE = 250;

const ATOMS = /^(0|[1-9][0-9]*)$/;
const listedCoinBalanceSchema = z.object({ balance: z.string().regex(ATOMS), coinType: z.string() });
const EXACT_WALLET_TYPES = [PORTFOLIO_COIN_TYPES.usdc, PORTFOLIO_COIN_TYPES.sui];

export async function readCoinBalance(fullnode: CoinsFullnode, owner: string, coinType: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const answer = await fullnode.getBalance({ owner, coinType, signal });
  signal.throwIfAborted();
  const atoms = socialWalletBalanceSchema.shape.atoms.safeParse(answer?.balance?.balance);
  if (!atoms.success) throw new Error("The fullnode answered a malformed balance.");
  return atoms.data;
}

/** `coinType` in canonical form, or null when it does not parse or the wire cannot carry it (it would reject the whole wallet). */
function wireCoinType(coinType: string): string | null {
  try {
    const type = normalizeStructTag(coinType);
    return socialWalletCoinSchema.shape.coin_type.safeParse(type).success ? type : null;
  } catch {
    return null;
  }
}

/**
 * Every balance of `owner`, by canonical coin type (coin objects plus the
 * address balance, as the fullnode sums them). Read SUI and USDC explicitly,
 * and resolve repeated entries with an exact read because the pages contain
 * totals. A failed, late or malformed answer rejects the whole read. Coin
 * types the wire cannot carry are left out.
 */
export async function readOwnerBalances(
  fullnode: CoinsFullnode,
  owner: string,
  timeoutMs = COINS_FULLNODE_TIMEOUT_MS,
): Promise<Map<string, bigint>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("The fullnode did not answer in time."));
    }, timeoutMs);
  });
  const read = async () => {
    const balances = new Map<string, bigint>();
    const repeated = new Set<string>();
    const collect = (entry: ListedCoinBalance) => {
      if (!listedCoinBalanceSchema.safeParse(entry).success) throw new Error("The fullnode answered a malformed balance.");
      const type = wireCoinType(entry.coinType);
      if (type === null) return;
      if (balances.has(type)) repeated.add(type);
      else balances.set(type, BigInt(entry.balance));
    };
    let cursor: string | null = null;
    const seen = new Set<string>();
    while (!controller.signal.aborted) {
      const answer = await fullnode.listBalances({ owner, limit: COINS_PAGE_SIZE, cursor, signal: controller.signal });
      for (const entry of answer.balances) collect(entry);
      if (!answer.hasNextPage) break;
      if (!answer.cursor || seen.has(answer.cursor)) throw new Error("The fullnode answered a non-progressing balance cursor.");
      seen.add(answer.cursor);
      cursor = answer.cursor;
    }
    for (const coinType of repeated) {
      if (EXACT_WALLET_TYPES.includes(coinType)) continue;
      balances.set(coinType, BigInt(await readCoinBalance(fullnode, owner, coinType, controller.signal)));
    }
    return balances;
  };
  const tasks = [read(), ...EXACT_WALLET_TYPES.map(async (coinType) => (
    [coinType, BigInt(await readCoinBalance(fullnode, owner, coinType, controller.signal))] as const
  ))] as const;
  try {
    const [listed, ...own] = await Promise.race([
      Promise.all(tasks),
      deadline,
    ]);
    for (const [coinType, atoms] of own) listed.set(coinType, atoms);
    return listed;
  } finally {
    clearTimeout(timer);
    controller.abort();
    await Promise.allSettled(tasks);
  }
}

/**
 * `coin` as the wire can carry it. Coin metadata is whatever its publisher
 * wrote, and the client rejects the whole wallet over one bad field, so each
 * field the contract rejects is repaired: text is cut to its bound, an empty
 * symbol becomes the type's name and an empty name the symbol, bad decimals
 * drop the price with them, a bad price, logo or presale multiple becomes
 * none, and a presale still off the wire becomes none. A coin that still
 * fails is left out.
 */
export function wireWalletCoin(coin: SocialWalletCoin): SocialWalletCoin | null {
  const field = socialWalletCoinSchema.shape;
  const symbol = wireText(coin.symbol, 32) ?? coinTypeName(coin.coin_type, 32);
  const decimals = field.decimals.safeParse(coin.decimals).success ? coin.decimals : null;
  const priced = decimals === coin.decimals && field.usd_price.safeParse(coin.usd_price).success && field.value_usd.safeParse(coin.value_usd).success;
  const fixed: SocialWalletCoin = {
    ...coin,
    symbol,
    name: wireText(coin.name, 64) ?? symbol,
    decimals,
    usd_price: priced ? coin.usd_price : null,
    value_usd: priced ? coin.value_usd : null,
    icon_url: wireIconUrl(coin.icon_url),
    presale: [coin.presale, coin.presale && { ...coin.presale, multiple: null }].find((presale) => field.presale.safeParse(presale).success) ?? null,
  };
  return socialWalletCoinSchema.safeParse(fixed).success ? fixed : null;
}

type SaleCoinRow = { presale_id: string | null; sale_token: string };

/** Which of these coin types are presale sale coins (`chain_read_v1.presales.sale_token`). */
const SALE_COINS_SQL = `
  SELECT presale_id, sale_token FROM ${SHOWN_PRESALES} WHERE sale_token = ANY($1::text[])`;
const SWAP_SALE_COINS_SQL = `${SALE_COINS_SQL}
  UNION ALL
  SELECT NULL::text, coin_type FROM ${TEST_SUI_LAUNCH_TYPES} blocked WHERE coin_type = ANY($1::text[])`;

function heldCoinTypes(balances: ReadonlyMap<string, bigint>, hideTestMarkets: boolean): string[] {
  return [...balances.entries()]
    .filter(([type, atoms]) => atoms > 0n && type !== PORTFOLIO_COIN_TYPES.usdc && type !== PORTFOLIO_COIN_TYPES.sui &&
      (!hideTestMarkets || !TEST_SUI_COIN_TYPES.includes(type)))
    .map(([type]) => type);
}

async function readWalletSaleOrigins(db: ReadableDatabase, types: readonly string[], hideTestMarkets: boolean) {
  if (types.length === 0) return { saleRows: [], hidden: new Set<string>() };
  const { rows } = await db.read<SaleCoinRow>(hideTestMarkets ? SWAP_SALE_COINS_SQL : SALE_COINS_SQL, [types]);
  const hidden = new Set(rows.flatMap((row) => row.presale_id === null ? [row.sale_token] : []));
  const saleRows = rows.flatMap(({ presale_id, sale_token }) =>
    presale_id === null || hidden.has(sale_token) ? [] : [{ presale_id, sale_token }]);
  return { saleRows, hidden };
}

type PriceRow = { coin_type: string; usd_price: string; as_of_ms: string };

const WALLET_PRICES_SQL = `SELECT coin_type, usd_price::text AS usd_price, as_of_ms::text AS as_of_ms FROM chain_read_v1.prices WHERE coin_type = ANY($1::text[])`;

const fixed = (value: number, places: number) => (Math.round(value * 10 ** places) / 10 ** places).toFixed(places);

/** A decimal string for a positive JavaScript price, without exponent notation. */
function priceText(value: number): string | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const text = value.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
  return text === "" ? "0" : text;
}

/**
 * The Blast wallet's coins from its balances: USDC (at $1, as every balance
 * card counts it) and SUI (at its `chain_read_v1.prices` price fresher than
 * 120 s), always, then each presale sale coin it holds, by value (unpriced
 * last), at the price the profile's holdings use (`presalePrices`). Other
 * holdings use indexed metadata and prices; unknown metadata keeps raw atoms.
 * Every coin passes `wireWalletCoin`, so no coin's metadata fails the read.
 */
export async function walletCoins(
  db: ReadableDatabase,
  balances: ReadonlyMap<string, bigint>,
  nowMs: number,
  hideTestMarkets = false,
): Promise<SocialWalletCoin[]> {
  const usdcAtoms = (balances.get(PORTFOLIO_COIN_TYPES.usdc) ?? 0n).toString();
  const suiAtoms = (balances.get(PORTFOLIO_COIN_TYPES.sui) ?? 0n).toString();
  const others = heldCoinTypes(balances, hideTestMarkets);
  const [priceRows, { saleRows, hidden }, metadata] = await Promise.all([
    db.read<PriceRow>(WALLET_PRICES_SQL, [[PORTFOLIO_COIN_TYPES.sui, ...others]]).then((result) => result.rows),
    readWalletSaleOrigins(db, others, hideTestMarkets),
    readCoinMetadata(db, others),
  ]);
  const prices = new Map(priceRows.map((row) => [row.coin_type, { usd_price: row.usd_price, as_of_ms: Number(row.as_of_ms) }]));
  const suiPrice: PortfolioPrice | undefined = prices.get(PORTFOLIO_COIN_TYPES.sui);
  const freshSui = isFreshPrice(suiPrice, nowMs) ? suiPrice : null;
  const facts = await readPresaleFacts(db, saleRows.map((row) => row.presale_id), nowMs);

  const sale: SocialWalletCoin[] = [];
  for (const row of saleRows) {
    const presale = facts.get(row.presale_id);
    const atoms = balances.get(normalizeStructTag(row.sale_token));
    if (!presale || atoms === undefined || atoms === 0n) continue;
    const { current, multiple } = presalePrices(presale, nowMs);
    const price = current === null ? null : priceText(current);
    sale.push({
      coin_type: normalizeStructTag(row.sale_token),
      symbol: presale.presale.symbol,
      name: presale.presale.name,
      decimals: presale.saleDecimals,
      atoms: atoms.toString(),
      usd_price: price,
      value_usd: price === null ? null : atomsToUsd(atoms.toString(), presale.saleDecimals, price),
      icon_url: presale.presale.icon_url,
      presale: {
        presale_id: row.presale_id,
        venue: presale.presale.venue,
        // Trading in the app: migrated to a venue its trade reaches (Cetus, Bluefin, an Aftermath DAO-fee pool).
        trading: presale.presale.status === "trading" && tradesInApp(presale.presale.venue),
        multiple: multiple === null ? null : fixed(multiple, 4),
      },
    });
  }
  const listed = new Set(sale.map((coin) => coin.coin_type));
  sale.push(...others.filter((type) => !listed.has(type) && !hidden.has(type)).map((type) => {
    const coin = metadata.get(type);
    const preferred = PREFERRED_COINS.find(coin => coin.coinType === type);
    const symbol = coin?.symbol || preferred?.symbol || "";
    const decimals = coin?.decimals ?? preferred?.decimals ?? null;
    const observed = prices.get(type);
    const price = decimals !== null && isFreshPrice(observed, nowMs) ? observed!.usd_price : null;
    const atoms = balances.get(type)!.toString();
    return {
      coin_type: type, symbol, name: coin?.name || preferred?.name || symbol, decimals, atoms,
      usd_price: price, value_usd: price === null ? null : atomsToUsd(atoms, decimals!, price),
      icon_url: wireIconUrl(coin?.icon_url) ?? wireIconUrl(preferred?.logoUrl), presale: null,
    };
  }));
  const holdings = sale.map((coin) => TEST_SUI_COIN_TYPES.includes(coin.coin_type)
    ? { ...coin, usd_price: "0", value_usd: "0.00" }
    : coin);
  holdings.sort((a, b) => (b.value_usd === null ? -1 : Number(b.value_usd)) - (a.value_usd === null ? -1 : Number(a.value_usd)) || a.symbol.localeCompare(b.symbol));

  const coins: SocialWalletCoin[] = [
    {
      coin_type: PORTFOLIO_COIN_TYPES.usdc,
      symbol: "USDC",
      name: "USDC",
      decimals: 6,
      atoms: usdcAtoms,
      usd_price: "1",
      value_usd: atomsToUsd(usdcAtoms, 6, "1"),
      icon_url: null,
      presale: null,
    },
    {
      coin_type: PORTFOLIO_COIN_TYPES.sui,
      symbol: "SUI",
      name: "SUI",
      decimals: 9,
      atoms: suiAtoms,
      usd_price: freshSui ? freshSui.usd_price : null,
      value_usd: freshSui ? atomsToUsd(suiAtoms, 9, freshSui.usd_price) : null,
      icon_url: null,
      presale: null,
    },
    ...holdings,
  ];
  return includePreferredCoins(coins).flatMap((coin) => wireWalletCoin(coin) ?? []);
}

function includePreferredCoins(coins: readonly SocialWalletCoin[]): SocialWalletCoin[] {
  const heldTypes = new Set(coins.map(coin => coin.coin_type));
  return [...coins.map(coin => coin.atoms === "0" ? { ...coin, value_usd: "0.00" } : coin), ...PREFERRED_COINS.filter(coin => !heldTypes.has(coin.coinType)).map(coin => ({
    coin_type: coin.coinType, symbol: coin.symbol, name: coin.name, decimals: coin.decimals,
    atoms: "0", usd_price: null, value_usd: "0.00", icon_url: coin.logoUrl, presale: null,
  }))];
}
