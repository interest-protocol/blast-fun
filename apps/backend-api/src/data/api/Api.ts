import * as HttpApi from "effect/http-api/HttpApi";
import { MarketApi } from "./market/MarketApi.ts";

export const Api = HttpApi.make("blast-backend")
  .add(MarketApi)
  .annotate(HttpApi.QueryParseOptions, { onExcessProperty: "error" });
