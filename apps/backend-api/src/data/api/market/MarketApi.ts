import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import * as Schema from "effect/Schema";
import {
  ActivityQuery,
  CandlePage,
  CandleQuery,
  CheckpointQuery,
  CoinParams,
  CreatorClaimsQuery,
  HoldersQuery,
  LaunchParams,
  MarketError,
  MarketStatus,
  PageQuery,
  PartnerParams,
  PoolParams,
  TradeParams,
  TradesQuery,
  WalletParams,
} from "./schemas.ts";

export class MarketDecodeErrors extends HttpApiMiddleware.Service<MarketDecodeErrors>()(
  "blast/backend-api/market/MarketDecodeErrors",
) {}

// The relay also preserves other upstream error statuses with the market error body.
const marketErrors = [400, 404, 429, 500, 502, 503, 504].map((status) =>
  HttpApiSchema.status(status)(MarketError),
);

const candleContract = {
  query: CandleQuery,
  success: CandlePage,
  error: marketErrors,
} as const;

// Preserve the provider's JSON wire data. The SDK validates each read's domain contract.
const relayContract = { success: Schema.Json, error: marketErrors } as const;

export const MarketApi = HttpApiGroup.make("market")
  .add(
    HttpApiEndpoint.get("status", "/api/launchpad/market/status", {
      query: Schema.Record(Schema.String, Schema.Never),
      success: MarketStatus,
      error: marketErrors,
    }),
    HttpApiEndpoint.get("coinCandles", "/api/launchpad/market/coins/:coinType/candles", {
      ...candleContract,
      params: CoinParams,
    }),
    HttpApiEndpoint.get("poolCandles", "/api/launchpad/market/pools/:venue/:poolId/candles", {
      ...candleContract,
      params: PoolParams,
    }),
    HttpApiEndpoint.get("coin", "/api/launchpad/market/coins/:coinType", {
      ...relayContract,
      params: CoinParams,
      query: CheckpointQuery,
    }),
    HttpApiEndpoint.get("holders", "/api/launchpad/market/coins/:coinType/holders", {
      ...relayContract,
      params: CoinParams,
      query: HoldersQuery,
    }),
    HttpApiEndpoint.get("activity", "/api/launchpad/market/launches/:launchId/activity", {
      ...relayContract,
      params: LaunchParams,
      query: ActivityQuery,
    }),
    HttpApiEndpoint.get("pool", "/api/launchpad/market/pools/:venue/:poolId", {
      ...relayContract,
      params: PoolParams,
      query: CheckpointQuery,
    }),
    HttpApiEndpoint.get("trades", "/api/launchpad/market/pools/:venue/:poolId/trades", {
      ...relayContract,
      params: TradeParams,
      query: TradesQuery,
    }),
    HttpApiEndpoint.get("rewards", "/api/launchpad/market/launches/:launchId/rewards", {
      ...relayContract,
      params: LaunchParams,
      query: CheckpointQuery,
    }),
    HttpApiEndpoint.get("rewardRounds", "/api/launchpad/market/launches/:launchId/reward-rounds", {
      ...relayContract,
      params: LaunchParams,
      query: PageQuery,
    }),
    HttpApiEndpoint.get("walletLaunches", "/api/launchpad/market/wallets/:address/launches", {
      ...relayContract,
      params: WalletParams,
      query: PageQuery,
    }),
    HttpApiEndpoint.get(
      "walletLaunchRewards",
      "/api/launchpad/market/wallets/:address/launch-rewards",
      {
        ...relayContract,
        params: WalletParams,
        query: PageQuery,
      },
    ),
    HttpApiEndpoint.get(
      "walletHolderRewards",
      "/api/launchpad/market/wallets/:address/launch-holder-rewards",
      {
        ...relayContract,
        params: WalletParams,
        query: PageQuery,
      },
    ),
    HttpApiEndpoint.get("creatorClaims", "/api/launchpad/market/creator-claims", {
      ...relayContract,
      query: CreatorClaimsQuery,
    }),
    HttpApiEndpoint.get("partners", "/api/launchpad/market/partners", {
      ...relayContract,
      query: PageQuery,
    }),
    HttpApiEndpoint.get("partner", "/api/launchpad/market/partners/:partnerId", {
      ...relayContract,
      params: PartnerParams,
      query: CheckpointQuery,
    }),
    HttpApiEndpoint.get("partnerLaunches", "/api/launchpad/market/partners/:partnerId/launches", {
      ...relayContract,
      params: PartnerParams,
      query: PageQuery,
    }),
    HttpApiEndpoint.get("policy", "/api/launchpad/market/launchpad/policy", {
      ...relayContract,
      query: CheckpointQuery,
    }),
  )
  .middleware(MarketDecodeErrors);
