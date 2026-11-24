import { TRADER_PROFILES_PATH, parseTraderProfilesRequest } from "@blast/core/modules/social/contracts/trader-profiles.ts";
import { readTraderProfiles } from "./trader-profiles.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { SocialAccountWalletLister } from "@blast/server/modules/social/accounts/me-route.ts";
import type { PresaleTermsReader } from "@blast/core/modules/presale/terms/index.ts";
import type { SocialConfig } from "@blast/core/modules/social/contracts/config.ts";
import { z } from "zod";
import { socialParameter, socialSingle } from "@blast/server/modules/social/route-kit/validation.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import type { SocialRequestContext, SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";

import {
  SOCIAL_HOME_TRADERS_ROUTE,
  SOCIAL_HOME_ACTIVITY_STREAM_ROUTE,
  HOME_DEFAULT_WINDOW,
  HOME_DEX_VOLUME_PARAM,
  HOME_MOBILE_MARKET_PARAM,
  HOME_ROLLING_CHANGE_PARAM,
  HOME_TOP_HOLDERS,
  SOCIAL_HOME_ACTIVITY_ROUTE,
  SOCIAL_HOME_COINS_ROUTE,
  SOCIAL_HOME_DISCUSSION_ROUTE,
  SOCIAL_HOME_FOLLOWING_ROUTE,
  SOCIAL_HOME_ROUTE,
  isHomeWindow,
} from "@blast/core/modules/social/contracts/home.ts";
import { parseHolderLimit, parsePresaleIds, readHomeCoinsByIds, readHomeDiscover, type HomeReadContext } from "@blast/server/modules/social/home/coins.ts";
import { parseDiscussionQuery, readHomeDiscussion } from "@blast/server/modules/social/home/discussion.ts";
import { readHomeFollowing } from "@blast/server/modules/social/home/following.ts";
import { readFollowingRequest } from "@blast/server/modules/social/home/following-request.ts";
import type { ReadCache } from "@blast/server/modules/social/read-cache.ts";
import type { HomeCoinsPage, HomeCoinsByIds, HomeActivityStreamPage, HomeThreadPage } from "@blast/core/modules/social/contracts/home.ts";
import { parseTradersQuery, readHomeTraders, type TraderLedger } from "@blast/server/modules/social/home/traders.ts";
import { parseHomeQuery } from "@blast/server/modules/social/home/rank.ts";
import { parseThreadQuery, readHomeThread } from "@blast/server/modules/social/home/thread.ts";
import { parseActivityStreamQuery, readHomeActivityStream } from "./activity-stream.ts";
import {
  SOCIAL_HOME_HOLDERS_ROUTE,
  SOCIAL_HOME_MARKET_ROUTE,
  SOCIAL_HOME_MY_TRADES_ROUTE,
  SOCIAL_HOME_TRADES_ROUTE,
  type HomeChartTradesPage,
  type HomeCoinMarket,
  type HomeHoldersPage,
} from "@blast/core/modules/social/contracts/coin-market.ts";
import { parseChartTradesQuery, readChartTrades } from "@blast/server/modules/social/home/chart-trades.ts";
import { parseHoldersLimit, readHomeHolders } from "@blast/server/modules/social/home/holders.ts";
import { parseMarketCoin, readHomeMarket } from "@blast/server/modules/social/home/market.ts";

export type SocialHomeRouteDependencies = Readonly<{
  kit: SocialRouteKit;
  /** The read replica in production (`socialFeedDatabase`). Resolved per request. */
  database: () => ReadableDatabase;
  /** The primary (`socialPortfolioDatabase`), for the traders' indexed wallet history alongside account visibility. */
  ledgerDatabase: () => ReadableDatabase;
  /** The accounts' wallets with their kinds (`socialAccounts`), as the profile's P&L reads them. */
  wallets: SocialAccountWalletLister;
  /** The tuning values of the item mapper (`getSocialConfig`), for the discussion view. */
  config: () => Promise<SocialConfig>;
  /** The sales' terms (`createPresaleTermsReader`), for FDV; null when the projection is not configured. */
  terms: PresaleTermsReader | null;
  trackedPoolMarket?: HomeReadContext["trackedPoolMarket"];
  now?: () => number;
  caches?: Readonly<{
    discover?: ReadCache<HomeCoinsPage>;
    coins?: ReadCache<HomeCoinsByIds>;
    portfolios?: TraderLedger["cache"];
    activity?: ReadCache<HomeActivityStreamPage>;
    thread?: ReadCache<HomeThreadPage>;
    market?: ReadCache<HomeCoinMarket>;
    holders?: ReadCache<HomeHoldersPage>;
    trades?: ReadCache<HomeChartTradesPage>;
  }>;
}>;

/**
 * The Home routes (contract in `contracts/home.ts`). The public reads:
 * no authentication (no token or cookie is read), bucket `social_read`, a
 * 200 publicly cached (`SOCIAL_PUBLIC_CACHE_CONTROL`); errors `no-store`.
 * The Following read: account required, bucket `social_read`, every answer
 * `private, no-store`, through the kit's transaction on the primary.
 */
export function createSocialHomeRoutes(dependencies: SocialHomeRouteDependencies) {
  const { kit, database, ledgerDatabase, wallets, config, terms, trackedPoolMarket } = dependencies;
  const now = dependencies.now ?? Date.now;
  const context = (ctx: SocialRequestContext) => ({ nowMs: now(), hiddenKinds: ctx.hiddenKinds, terms });
  const wantsMobileMarket = (params: URLSearchParams) => params.get(HOME_MOBILE_MARKET_PARAM) === "1";
  const marketOptions = (params: URLSearchParams) => ({
    includeMobileMarket: wantsMobileMarket(params),
    includeLiveInputs: wantsMobileMarket(params) && params.get("live_inputs") === "1",
    includeRollingChange: wantsMobileMarket(params) && params.get(HOME_ROLLING_CHANGE_PARAM) === "1",
    includeDexVolume: params.get(HOME_DEX_VOLUME_PARAM) === "1",
  });
  const publicRead = { auth: "none", bucket: "social_read", cache: "public" } as const;
  return Object.freeze({
    DISCOVER: kit.route({ name: SOCIAL_HOME_ROUTE, ...publicRead }, async (ctx) => {
      const params = new URL(ctx.request.url).searchParams;
      const query = parseHomeQuery(params);
      const ctxRead = { ...context(ctx), ...marketOptions(params), trackedPoolMarket };
      const load = () => readHomeDiscover(database(), query, ctxRead);
      return cachedResponse(ctx, dependencies.caches?.discover, JSON.stringify([query, ctxRead.hiddenKinds, ctxRead.includeMobileMarket, ctxRead.includeLiveInputs, ctxRead.includeRollingChange, ctxRead.includeDexVolume]), load);
    }),
    COINS: kit.route({ name: SOCIAL_HOME_COINS_ROUTE, ...publicRead }, async (ctx) => {
      const params = new URL(ctx.request.url).searchParams;
      const ids = parsePresaleIds(params);
      const windows = params.getAll("window");
      const window = windows[0] ?? HOME_DEFAULT_WINDOW;
      if (windows.length > 1 || !isHomeWindow(window)) throw new SocialRouteError("invalid_parameter", { extra: { parameter: "window" } });
      const holderLimit = parseHolderLimit(params, ids.length);
      const ctxRead = { ...context(ctx), holderLimit, ...marketOptions(params), trackedPoolMarket };
      const load = () => readHomeCoinsByIds(database(), ids, window, ctxRead);
      const key = [ids, window, ctxRead.hiddenKinds, ctxRead.includeMobileMarket, ctxRead.includeLiveInputs, ctxRead.includeRollingChange, ctxRead.includeDexVolume, ...(holderLimit === HOME_TOP_HOLDERS ? [] : [holderLimit])];
      return cachedResponse(ctx, dependencies.caches?.coins, JSON.stringify(key), load);
    }),
    TRADERS: kit.route({ name: SOCIAL_HOME_TRADERS_ROUTE, ...publicRead, cache: "public-fresh" }, async (ctx) => {
      const { window, ...query } = parseTradersQuery(new URL(ctx.request.url).searchParams);
      return ctx.json(await readHomeTraders(database(), window, { ...context(ctx), portfolios: { db: ledgerDatabase(), wallets, cache: dependencies.caches?.portfolios } }, query));
    }),
    ACTIVITY_STREAM: kit.route({ name: SOCIAL_HOME_ACTIVITY_STREAM_ROUTE, ...publicRead }, async (ctx) => {
      const query = parseActivityStreamQuery(new URL(ctx.request.url).searchParams);
      const ctxRead = context(ctx);
      return cachedResponse(ctx, dependencies.caches?.activity, JSON.stringify([query, ctxRead.hiddenKinds]), () => readHomeActivityStream(database(), query, ctxRead));
    }),
    ACTIVITY: kit.route({ name: SOCIAL_HOME_ACTIVITY_ROUTE, ...publicRead }, async (ctx) => {
      const params = new URL(ctx.request.url).searchParams;
      const query = parseThreadQuery(params);
      const at = socialSingle(params, "at");
      const checkpoint = at === null ? undefined : socialParameter(
        z.string().regex(/^(0|[1-9][0-9]{0,15})$/).transform(Number).pipe(z.int()),
        at,
        "at",
      );
      // Share the CDN read for a checkpoint, but leave a lagging replica's response uncached.
      const load = () => readHomeThread(database(), {
        ...query,
        nowMs: now(),
        hiddenKinds: ctx.hiddenKinds,
        actors: { kind: "everyone" },
        ...(checkpoint === undefined ? {} : { minimumMarketCheckpoint: checkpoint }),
      });
      return cachedResponse(ctx, dependencies.caches?.thread, JSON.stringify([query, checkpoint, ctx.hiddenKinds]), load);
    }),
    DISCUSSION: kit.route({ name: SOCIAL_HOME_DISCUSSION_ROUTE, ...publicRead }, async (ctx) => {
      const query = parseDiscussionQuery(new URL(ctx.request.url).searchParams);
      return ctx.json(await readHomeDiscussion(database(), query, { config: await config(), nowMs: now(), hiddenKinds: ctx.hiddenKinds }));
    }),
    MARKET: kit.route({ name: SOCIAL_HOME_MARKET_ROUTE, ...publicRead }, async (ctx) => {
      const coin = parseMarketCoin(new URL(ctx.request.url).searchParams);
      const ctxRead = context(ctx);
      return cachedResponse(ctx, dependencies.caches?.market, JSON.stringify([coin, ctxRead.hiddenKinds]), () => readHomeMarket(database(), coin, ctxRead));
    }),
    // A holder's P&L shows only while its owner shares the portfolio: never served stale, as Home's traders are not.
    HOLDERS: kit.route({ name: SOCIAL_HOME_HOLDERS_ROUTE, ...publicRead, cache: "public-fresh" }, async (ctx) => {
      const params = new URL(ctx.request.url).searchParams;
      const coin = parseMarketCoin(params);
      const limit = parseHoldersLimit(params);
      const ctxRead = context(ctx);
      return cachedResponse(ctx, dependencies.caches?.holders, JSON.stringify([coin, limit, ctxRead.hiddenKinds]), () => readHomeHolders(database(), coin, limit, ctxRead), { fresh: true });
    }),
    TRADES: kit.route({ name: SOCIAL_HOME_TRADES_ROUTE, ...publicRead }, async (ctx) => {
      const query = parseChartTradesQuery(new URL(ctx.request.url).searchParams);
      const ctxRead = context(ctx);
      return cachedResponse(ctx, dependencies.caches?.trades, JSON.stringify([query, ctxRead.hiddenKinds]), () => readChartTrades(database(), query, null, ctxRead));
    }),
    TRADER_PROFILES: kit.route({ name: `GET ${TRADER_PROFILES_PATH}`, auth: "none", bucket: "social_read", cache: "private" }, async (ctx) => {
      const traders = parseTraderProfilesRequest(new URL(ctx.request.url), now());
      if (!traders) throw new SocialRouteError("invalid_parameter", { extra: { parameter: "traders" } });
      return ctx.json(await readTraderProfiles(database(), traders));
    }),
    MY_TRADES: kit.route(
      { name: SOCIAL_HOME_MY_TRADES_ROUTE, auth: "account", account: "required", bucket: "social_read", cache: "private" },
      async (ctx) => {
        const query = parseChartTradesQuery(new URL(ctx.request.url).searchParams, true);
        const addresses = (await wallets.wallets(ctx.account!.account_id)).map((wallet) => wallet.address);
        return ctx.json(await readChartTrades(database(), query, addresses, context(ctx)));
      },
    ),
    FOLLOWING: kit.route(
      { name: SOCIAL_HOME_FOLLOWING_ROUTE, auth: "account", account: "required", bucket: "social_read", cache: "private" },
      async (ctx) => {
        const body = await readFollowingRequest(ctx.request);
        const accountId = ctx.account!.account_id;
        const params = new URL(ctx.request.url).searchParams;
        const ctxRead = { ...context(ctx), ...(body.mode === "coins" && marketOptions(params)) };
        const answer = await ctx.transaction(
          (social) => readHomeFollowing(social, accountId, body, ctxRead),
          { label: "social.home_following" },
        );
        return ctx.json(answer);
      },
    ),
  });
}

export type SocialHomeRoutes = ReturnType<typeof createSocialHomeRoutes>;

/**
 * Spend the same ten-second freshness budget at origin and edge, never twice.
 * `fresh`: an answer its owner can withdraw is never served stale either.
 */
async function cachedResponse<T>(
  ctx: SocialRequestContext,
  cache: ReadCache<T> | undefined,
  key: string,
  load: () => Promise<T>,
  options: Readonly<{ fresh?: boolean }> = {},
): Promise<Response> {
  let ageMs = 0;
  const value = cache ? await cache.read(key, load, (age) => { ageMs = age; }) : await load();
  const response = ctx.json(value);
  if (cache && response.headers.get("cache-control")?.startsWith("public,")) {
    const remaining = Math.max(0, Math.floor(10 - ageMs / 1000));
    const stale = options.fresh ? "" : ", stale-while-revalidate=20";
    response.headers.set("cache-control", remaining > 0 ? `public, s-maxage=${remaining}${stale}` : "no-store");
  }
  return response;
}
