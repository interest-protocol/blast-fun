"use client";

import { useEffect, useState } from "react";
import type { ActivityRow } from "../../../../../../../packages/core/src/modules/launchpad-contract/activity.ts";
import { AppShell } from "../../../../../src/components/blast-ui/AppShell.tsx";
import { BondingCoinScreen } from "../../../../../src/components/social/bonding/BondingCoinScreen.tsx";
import { usePublishWalletTrades } from "../../../../../src/components/launchpad/activity/wallet-trades.tsx";
import { noteOwnTrade, publishChartPrice } from "../../../../../src/components/launchpad/chart/chart-live-price.ts";
import { QueryProvider } from "../../../../../src/lib/query/provider.tsx";
import { createTestQueryClient } from "../../../../../src/lib/query/test-client.ts";
import { coinScreenFixture } from "../../../social/bonding/coin-screen-fixtures.ts";
import { CURVE_POOL_KEY } from "../../../../../../../packages/core/test/fixtures/modules/launchpad-coin/fixtures.ts";

const client = createTestQueryClient();
const page = coinScreenFixture("live");
if (page.curve.state !== "available") throw new Error("The live fixture reads its curve");
const curve = page.curve;
const start = curve.provenance.checkpoint ?? 0;
const block = (label: string, height: number) => <div data-proof-slot={label} style={{ height }}>{label}</div>;
const NO_ROWS: readonly ActivityRow[] = [];
const LAST_TRADE = "price-row-proof:last-trade";
const LARGE_BUY = { quote: 987_654_321_000n, meme: 1n };

/** The activity feed: its newest trade becomes the header's "Last trade" note when the proof asks. */
function ActivitySlot() {
  const [latest, setLatest] = useState<ActivityRow | null>(null);
  useEffect(() => {
    const arrive = () => setLatest({
      kind: "curve_buy", source: null, actor: null, lifecycle: null, position: `${start + 1}:1:0:0`, checkpoint: start + 1,
      digest: "proof", timestampMs: Date.now(), amounts: LARGE_BUY,
    });
    window.addEventListener(LAST_TRADE, arrive);
    return () => window.removeEventListener(LAST_TRADE, arrive);
  }, []);
  usePublishWalletTrades(NO_ROWS, latest);
  return block("activity", 480);
}
const slots = {
  activity: <ActivitySlot />, chart: block("chart", 360), discovery: null, execution: block("execution", 420),
  holders: block("holders", 200), market: null, overview: null, theses: null,
};

declare global {
  interface Window { priceRowProof?: Readonly<{ publish(price: string): void; lastTrade(): void; trade(): void }> }
}

/**
 * The coin page from its first price to the viewer's own trade: the chart's
 * live close is shown, the activity feed names the last trade, then the
 * viewer's trade lands at a newer checkpoint than that close. The header must keep its place while it waits for a close that
 * includes the trade.
 */
export function PriceRowProof() {
  useEffect(() => {
    window.priceRowProof = {
      publish: (price) => publishChartPrice(CURVE_POOL_KEY, { provenance: curve.provenance, poolKey: CURVE_POOL_KEY, cursor: null, price }),
      lastTrade: () => window.dispatchEvent(new Event(LAST_TRADE)),
      trade: () => noteOwnTrade(page.launchId, start + 1),
    };
  }, []);
  return (
    <QueryProvider client={client}>
      <AppShell signedIn={false} viewer={null} portfolio={{ status: "unavailable" }} signInHref="/sign-in">
        <BondingCoinScreen page={page} details={null} slots={slots} />
        <div style={{ height: 1200 }} data-proof-tail="" />
      </AppShell>
    </QueryProvider>
  );
}
