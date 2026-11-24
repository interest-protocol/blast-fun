"use client";

import { TrendingCoinStripView } from "./TrendingCoinStrip";

export function HomeRailLoading() {
  return <TrendingCoinStripView coins={null} expanded loading onOpen={() => undefined} />;
}
