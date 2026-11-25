import { COIN_TYPE, SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";
import { VENUES } from "@blast/core/modules/launchpad-contract/venues.ts";
import { CANDLE_INTERVALS } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import * as Schema from "effect/Schema";

const Interval = Schema.Literals(CANDLE_INTERVALS);
const Millis = Schema.String.check(Schema.isPattern(/^[0-9]{1,16}$/));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const ObjectId = Schema.String.check(Schema.isPattern(SUI_OBJECT_ID_PATTERN));
const Limit = Schema.String.check(Schema.isPattern(/^[0-9]{1,4}$/));
const At = Schema.optionalKey(Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]{0,15})$/)));
const checkpoint = { at: At };
const page = {
  limit: Schema.optionalKey(Schema.String),
  cursor: Schema.optionalKey(Schema.String),
  ...checkpoint,
};

const Provenance = Schema.Struct({
  network: Schema.String,
  deployment_fingerprint: Schema.NullOr(Schema.String),
  checkpoint: Schema.NullOr(Count),
  timestamp_ms: Schema.NullOr(Count),
  observed_ms: Count,
  lag_ms: Schema.NullOr(Count),
});

export const CoinParams = Schema.Struct({
  coinType: Schema.String.check(Schema.isPattern(COIN_TYPE)),
});

export const PoolParams = Schema.Struct({
  venue: Schema.Literals(VENUES),
  poolId: ObjectId,
});

export const LaunchParams = Schema.Struct({ launchId: ObjectId });

export const WalletParams = Schema.Struct({ address: ObjectId });

export const PartnerParams = Schema.Struct({ partnerId: ObjectId });

export const CheckpointQuery = Schema.Struct(checkpoint);

export const PageQuery = Schema.Struct(page);

export const HoldersQuery = Schema.Struct({
  ...checkpoint,
  view: Schema.Literal("snapshot"),
  limit: Schema.optionalKey(Limit),
  cursor: Schema.optionalKey(Schema.String),
});

export const ActivityQuery = Schema.Struct({
  ...page,
  view: Schema.Literal("classified"),
  wallet_labels: Schema.optionalKey(Schema.Literal("true")),
});

export const TradesQuery = Schema.Struct({
  ...checkpoint,
  before: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Limit),
});

export const CreatorClaimsQuery = Schema.Struct({
  ...page,
  recipient: Schema.optionalKey(ObjectId),
  account: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))),
});

export const CandleQuery = Schema.Struct({
  interval: Interval,
  from: Schema.optionalKey(Millis),
  to: Schema.optionalKey(Millis),
  limit: Schema.optionalKey(Limit),
  ...checkpoint,
});

export const CandlePage = Schema.Struct({
  interval: Interval,
  candles: Schema.Array(
    Schema.Struct({
      bucket_start: Count,
      interval: Interval,
      open: Schema.String,
      high: Schema.String,
      low: Schema.String,
      close: Schema.String,
      volume_quote: Schema.String,
      volume_meme: Schema.String,
      volume_usd: Schema.NullOr(Schema.String),
      buys: Count,
      sells: Count,
      trades: Count,
    }),
  ),
  migration: Schema.NullOr(
    Schema.Struct({
      cursor: Schema.String,
      timestamp_ms: Count,
      curve_pool_key: Schema.String,
      venue_pool_key: Schema.NullOr(Schema.String),
    }),
  ),
  provenance: Schema.optionalKey(Provenance),
});

export const MarketStatus = Schema.Struct({
  checkpoint: Schema.NullOr(Count),
  timestamp_ms: Schema.NullOr(Count),
  lag_ms: Schema.NullOr(Count),
  cursor: Schema.NullOr(Schema.String),
  provenance: Provenance,
});

export const MarketError = Schema.Struct({
  error: Schema.Struct({ code: Schema.String, message: Schema.String }),
});
