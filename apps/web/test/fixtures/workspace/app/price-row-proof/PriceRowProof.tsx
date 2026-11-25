"use client";

import { useEffect, useState } from "react";
import { AppShell } from "../../../../../src/components/blast-ui/AppShell.tsx";
import { BondingCoinScreen } from "../../../../../src/components/social/bonding/BondingCoinScreen.tsx";
import { publishChartPrice } from "../../../../../src/components/launchpad/chart/chart-live-price.ts";
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
const slots = {
  activity: block("activity", 480), chart: block("chart", 360), discovery: null, execution: block("execution", 420),
  holders: block("holders", 200), market: null, overview: null, theses: null,
};

declare global {
  interface Window { priceRowProof?: Readonly<{ publish(price: string): void; refresh(): void }> }
}

/**
 * The coin page after a trade: the chart's live close is shown, then the
 * page's refresh lands at a newer checkpoint than that close. The header
 * must keep its place while it waits for a close that covers the new read.
 */
export function PriceRowProof() {
  const [checkpoint, setCheckpoint] = useState(start);
  useEffect(() => {
    window.priceRowProof = {
      publish: (price) => publishChartPrice(CURVE_POOL_KEY, { provenance: { ...curve.provenance, checkpoint }, poolKey: CURVE_POOL_KEY, cursor: null, price }),
      refresh: () => setCheckpoint((value) => value + 1),
    };
  }, [checkpoint]);
  return (
    <QueryProvider client={client}>
      <AppShell signedIn={false} viewer={null} portfolio={{ status: "unavailable" }} signInHref="/sign-in">
        <BondingCoinScreen page={{ ...page, curve: { ...curve, provenance: { ...curve.provenance, checkpoint } } }} details={null} slots={slots} />
        <div style={{ height: 1200 }} data-proof-tail="" />
      </AppShell>
    </QueryProvider>
  );
}
