"use client";
import { QueryProvider } from "../../../src/lib/query/provider.tsx";
import { CoinCard } from "../../../src/components/social/coin-home/CoinCard.tsx";
import { Button } from "../../../src/components/blast-ui/Button.tsx";
import { setShellPref } from "../../../src/components/blast-ui/use-shell-prefs.ts";
import type { HomeCoin } from "@blast/core/modules/social/contracts/home.ts";
import homeStyles from "../../../src/components/social/coin-home/CoinHome.module.css";
import theme from "../../../src/components/social/blast-mode/workspace/WorkspaceTheme.module.css";
const coin: HomeCoin = {
  presale_id: null,
  coin_type: "0x1::fixture::TEST",
  symbol: "TEST",
  name: "A long fixture token name",
  icon_url: null,
  decimals: 9,
  lifecycle: "migrated",
  venue: "cetus",
  tradable: true,
  opened_ms: null,
  launched_ms: null,
  launch_id: null,
  quote: { type: "0x2::sui::SUI", symbol: "SUI", decimals: 9 },
  sale: null,
  price_usd: "0.0015",
  price_as_of_ms: null,
  change_24h_bps: 5000,
  holders: null,
  holders_as_of_ms: null,
  fdv_usd: null,
  spark: [
    [1790337600000, "0.001"],
    [1790337660000, "0.002"],
    [1790424000000, "0.0015"],
  ],
  activity: {
    scope: "pool",
    window: "24h",
    from_ms: 0,
    to_ms: 1,
    participants: 0,
    events: 0,
    buyers: 0,
    sellers: 0,
    backers: 0,
    claimers: 0,
    bought: [],
    sold: [],
    committed: [],
    latest_ms: null,
    preview: [],
  },
  top_holders: { holders: [], share_bps: null },
  discussion: { posts: 0 },
  rank: { score: 0, why: "" },
};

export function HomeChartsFixture() {
  return (
    <QueryProvider>
      <div data-blast-ui="" data-theme="light">
        <div
          className={theme.theme}
          style={{
            padding: 16,
            minHeight: "100vh",
            background: "var(--bg)",
            color: "var(--ink)",
          }}
        >
          <h1>Home coin rows · synthetic chart verification</h1>
          <Button onClick={() => setShellPref("theme", "light")}>
            Light theme
          </Button>
          <Button onClick={() => setShellPref("theme", "dark")}>
            Dark theme
          </Button>
          <div className={homeStyles.home}>
            <ol className={`${homeStyles.list} ${homeStyles.rankedList}`}>
              <CoinCard
                coin={coin}
                window="24h"
                nowMs={1790424000000}
                trading={false}
              />
              <CoinCard
                coin={{ ...coin, symbol: "EMPTY", spark: [] }}
                window="24h"
                nowMs={1790424000000}
                trading={false}
              />
            </ol>
          </div>
          <a href="https://www.tradingview.com/">Charts by TradingView</a>
        </div>
      </div>
    </QueryProvider>
  );
}
