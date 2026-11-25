import { classifiedActivityPath } from "@blast/core/modules/launchpad-contract/activity.ts";
import {
  LAUNCHPAD_POLICY_PATH,
  launchRewardsPath,
  partnerLaunchesPath,
  partnerPath,
  partnersPath,
  rewardRoundsPath,
  walletHolderRewardsPath,
  walletLaunchesPath,
  walletLaunchRewardsPath,
} from "@blast/core/modules/launchpad-contract/rewards.ts";
import {
  coinCandlesPath,
  poolCandlesPath,
  poolTradesPath,
  type CandleRequest,
} from "@blast/core/modules/launchpad-contract/venue-history.ts";
import {
  candleCache,
  checkpointCache,
  type createMarketRelay,
  invalidMarketParameters,
  MARKET_CACHE_CONTROL,
  MARKET_STATUS_UPSTREAM_PATH,
  marketCoinPath,
  marketCreatorClaimsPath,
  marketHoldersPath,
  marketParameterFailure,
  marketPoolPath,
  type MarketRouteName,
} from "@blast/server/modules/launchpad-market/routes.ts";
import { PRIVATE_NO_STORE } from "@blast/server/modules/read-routing/cache-policy.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import { Api } from "../../data/api/Api.ts";
import { MarketDecodeErrors } from "../../data/api/market/MarketApi.ts";
import type { CandleQuery } from "../../data/api/market/schemas.ts";

export class MarketRelay extends Context.Service<
  MarketRelay,
  ReturnType<typeof createMarketRelay>
>()("blast/backend-api/market/MarketRelay") {}

export const marketDecodeErrors = HttpApiMiddleware.layerSchemaErrorTransform(
  MarketDecodeErrors,
  () => Effect.sync(() => relayResponse(invalidMarketParameters())),
);

const readMarket = Effect.fnUntraced(function* (
  relay: typeof MarketRelay.Service,
  route: MarketRouteName,
  makePath: () => string,
  cache: (body: unknown) => string,
  at?: number,
) {
  const path = yield* Effect.try({ try: makePath, catch: marketParameterFailure }).pipe(
    Effect.result,
  );
  const response =
    path._tag === "Failure"
      ? path.failure
      : yield* Effect.promise(() => relay(route, path.success, cache, at));
  return relayResponse(response);
});

function readCandles(
  relay: typeof MarketRelay.Service,
  query: typeof CandleQuery.Type,
  makePath: (request: CandleRequest) => string,
) {
  const to = decimal(query.to);
  const at = decimal(query.at);
  return readMarket(
    relay,
    "candles",
    () =>
      makePath({
        interval: query.interval,
        from: decimal(query.from),
        to,
        limit: decimal(query.limit),
      }),
    candleCache(to, at),
    at,
  );
}

// Keep each admission slot until the shared relay finishes or hits its own timeout.
const options = { uninterruptible: true } as const;
const privateCache = () => PRIVATE_NO_STORE;

export const marketHandlers = HttpApiBuilder.group(Api, "market", (handlers) =>
  Effect.gen(function* () {
    const relay = yield* MarketRelay;

    function read(route: MarketRouteName, makePath: () => string, at: string | undefined) {
      const checkpoint = decimal(at);
      return readMarket(relay, route, makePath, checkpointCache(checkpoint), checkpoint);
    }

    function readPrivate(route: MarketRouteName, makePath: () => string) {
      return readMarket(relay, route, makePath, privateCache);
    }

    return handlers.handleAll({
      status: {
        handler: () =>
          Effect.promise(() =>
            relay("status", MARKET_STATUS_UPSTREAM_PATH, () => MARKET_CACHE_CONTROL),
          ).pipe(Effect.map(relayResponse)),
        options,
      },
      coinCandles: {
        handler: ({ params, query }) =>
          readCandles(relay, query, (request) => coinCandlesPath(params.coinType, request)),
        options,
      },
      poolCandles: {
        handler: ({ params, query }) =>
          readCandles(relay, query, (request) =>
            poolCandlesPath(`${params.venue}:${params.poolId}`, request),
          ),
        options,
      },
      coin: {
        handler: ({ params, query }) =>
          read("coin", () => marketCoinPath(params.coinType), query.at),
        options,
      },
      holders: {
        handler: ({ params, query }) =>
          read(
            "holders",
            () => marketHoldersPath(params.coinType, query.limit, query.cursor),
            query.at,
          ),
        options,
      },
      activity: {
        handler: ({ params, query }) =>
          read(
            "activity",
            () =>
              classifiedActivityPath(params.launchId, {
                limit: query.limit,
                cursor: query.cursor,
                walletLabels: query.wallet_labels === "true",
              }),
            query.at,
          ),
        options,
      },
      pool: {
        handler: ({ params, query }) =>
          read("pool", () => marketPoolPath(params.venue, params.poolId), query.at),
        options,
      },
      trades: {
        handler: ({ params, query }) =>
          read(
            "trades",
            () =>
              poolTradesPath(`${params.venue}:${params.poolId}`, {
                limit: decimal(query.limit),
                before: query.before,
              }),
            query.at,
          ),
        options,
      },
      rewards: {
        handler: ({ params, query }) =>
          read("rewards", () => launchRewardsPath(params.launchId), query.at),
        options,
      },
      rewardRounds: {
        handler: ({ params, query }) =>
          read("reward_rounds", () => rewardRoundsPath(params.launchId, query), query.at),
        options,
      },
      walletLaunches: {
        handler: ({ params, query }) =>
          readPrivate("wallet_launches", () => walletLaunchesPath(params.address, query)),
        options,
      },
      walletLaunchRewards: {
        handler: ({ params, query }) =>
          readPrivate("wallet_launch_rewards", () =>
            walletLaunchRewardsPath(params.address, query),
          ),
        options,
      },
      walletHolderRewards: {
        handler: ({ params, query }) =>
          readPrivate("wallet_holder_rewards", () =>
            walletHolderRewardsPath(params.address, query),
          ),
        options,
      },
      creatorClaims: {
        handler: ({ query }) =>
          readPrivate("creator_claims", () =>
            marketCreatorClaimsPath(query.recipient, query.account, query),
          ),
        options,
      },
      partners: {
        handler: ({ query }) => read("partners", () => partnersPath(query), query.at),
        options,
      },
      partner: {
        handler: ({ params, query }) =>
          read("partner", () => partnerPath(params.partnerId), query.at),
        options,
      },
      partnerLaunches: {
        handler: ({ params, query }) =>
          read("partner_launches", () => partnerLaunchesPath(params.partnerId, query), query.at),
        options,
      },
      policy: {
        handler: ({ query }) => read("policy", () => LAUNCHPAD_POLICY_PATH, query.at),
        options,
      },
    });
  }),
);

function relayResponse(response: Response): HttpServerResponse.HttpServerResponse {
  // The relay already bounds the body. Pass it through without re-encoding or creating a stream.
  return HttpServerResponse.raw(response, { status: response.status });
}

function decimal(input: string | undefined): number | undefined {
  return input === undefined ? undefined : Number(input);
}
