"use client";

import { pollInterval } from "#web/lib/query/polling.ts";
import { SkeletonRegion } from "#web/components/blast-ui/Skeleton.tsx";
import { Button } from "#web/components/blast-ui/Button.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { Segmented } from "#web/components/blast-ui/Segmented.tsx";
import { useQuery } from "@tanstack/react-query";
import { useContext, useState, type ReactNode } from "react";

import { NO_VALUE } from "@blast/core/web/format.ts";
import type { PriceMove } from "./sale-market-format";
import { ChartCard, MarketPriceRow } from "#web/components/social/bonding/CoinPageParts.tsx";
import coinStyles from "#web/components/social/bonding/bonding-coin.module.css";
import { ChartLastTrade } from "#web/components/launchpad/chart/ChartLastTrade.tsx";
import { ChartTradeContext } from "#web/components/launchpad/chart/chart-trade-context.ts";
import { ClientOnly } from "#web/components/ui-libraries/use-hydrated.tsx";
import { priceQuery } from "#web/components/social/prices/price-client.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import type { PriceWindow, SocialPriceHistory } from "@blast/core/web/contracts/prices.ts";
import type { SocialPresaleDetail } from "@blast/core/web/contracts/presales.ts";

import { cx } from "./cx";
import PricePlot from "./SalePricePlot";

const WINDOWS = [["24h", "24H"], ["launch", "Since launch"]] as const;

/** The delay notice and dollar price move from the market read. */
export type MarketExtras = Readonly<{ note?: ReactNode; move?: PriceMove | null }>;

export function SalePriceChart({ sale, trade, note, enabled = true, windows = WINDOWS }: Readonly<{ sale: SocialPresaleDetail["presale"]; trade: ReactNode; note?: ReactNode; enabled?: boolean; windows?: readonly (readonly [PriceWindow, string])[] }>) {
  const [window, setWindow] = useState<PriceWindow>("24h");
  const query = useQuery({
    ...priceQuery({ kind: "presale", id: sale.presale_id, window }),
    enabled,
    refetchInterval: (query) => pollInterval(15_000, query),
  }, useAppQueryClient());
  const history = query.data?.coin_type === sale.sale_token ? query.data : null;
  return <SalePriceChartView failed={query.isError} fetching={query.isFetching} history={history} loading={query.isPending} note={note} onWindow={setWindow} retry={() => { void query.refetch(); }} trade={trade} window={window} windows={windows} />;
}

function PriceHistory({ points, loading, failed, fetching, hasHistory, retry, quoteSymbol }: Readonly<{ points: SocialPriceHistory["points"]; loading: boolean; failed: boolean; fetching: boolean; hasHistory: boolean; retry?: () => void; quoteSymbol?: string }>) {
  if (failed) {
    const action = retry ? <Button aria-label={fetching ? "Retrying price history" : "Retry price history"} loading={fetching} loadingLabel="Retrying price history" onClick={retry} size="sm">Retry history</Button> : null;
    return <EmptyState action={action} role="alert" title="Price history could not load" />;
  }
  if (points.length >= 2) return <ClientOnly><PricePlot points={points} quoteSymbol={quoteSymbol} /></ClientOnly>;
  // The empty plot frame (its axes and gridlines) is the skeleton: the chart draws into the same box.
  if (loading) return <SkeletonRegion className={cx("trading-chart-loading")} label="Loading price history">{null}</SkeletonRegion>;
  const title = points.length === 1 ? "Waiting for more indexed prices to draw the chart" : hasHistory ? "No recorded prices in this period" : "No price history yet";
  return <EmptyState role="status" title={title} />;
}

export function SalePriceChartView({ history, loading, failed = false, fetching = false, retry, window, windows = WINDOWS, onWindow, trade, note }: Readonly<{
  history: SocialPriceHistory | null | undefined;
  loading: boolean;
  failed?: boolean;
  fetching?: boolean;
  retry?: () => void;
  window: PriceWindow;
  windows?: readonly (readonly [PriceWindow, string])[];
  onWindow: (window: PriceWindow) => void;
  trade: ReactNode;
  note?: ReactNode;
}>) {
  const quote = history?.price_usd == null ? history?.quote : undefined;
  const points = quote?.points ?? history?.points ?? [];
  const hasLine = points.length >= 2;
  const liveActivity = useContext(ChartTradeContext)?.placement === "headline";
  return (
    <div className={coinStyles.market} data-sale-market="">
      <ChartCard head={<MarketPriceRow price={NO_VALUE} activity={liveActivity && <ChartLastTrade placement="headline" playSound />} />}>
        <div className={cx("trading-market-actions")}>
          {trade}
          <Segmented label="Chart range" onChange={onWindow} options={windows} size="sm" value={window} />
        </div>
        <ChartLastTrade />
        <div aria-busy={loading || undefined} className={cx("trading-price-plot")} data-price-history={failed ? "error" : hasLine ? "available" : loading ? "loading" : "empty"}>
          <PriceHistory failed={failed} fetching={fetching} hasHistory={history != null} loading={loading} points={points} quoteSymbol={quote?.symbol} retry={retry} />
        </div>
        {note}
      </ChartCard>
    </div>
  );
}
