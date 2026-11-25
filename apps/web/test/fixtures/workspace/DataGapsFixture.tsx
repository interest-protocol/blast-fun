"use client";

import { useSyncExternalStore } from "react";
import { AppShell } from "../../../src/components/blast-ui/AppShell.tsx";
import { bricolage, geist, geistMono } from "../../../src/components/blast-ui/fonts.ts";
import { SettingsView } from "../../../src/components/social/settings/SettingsView.tsx";
import { NotificationsView } from "../../../src/components/social/notifications/NotificationsView.tsx";
import { CreateView } from "../../../src/components/social/create/CreateView.tsx";
import { createStore } from "../../../src/components/social/create/create-store.ts";
import { SocialViewerProvider } from "../../../src/components/social/SignInGate.tsx";
import { QueryProvider } from "../../../src/lib/query/provider.tsx";
import { CREATE_QUOTE_TYPE, CREATE_SUI_QUOTE_TYPE } from "@blast/core/modules/social/contracts/create.ts";
import { CREATE_DEFAULT_FEE_POLICY } from "@blast/core/modules/social/create/model.ts";
import { DEFAULT_NOTIFICATION_PREFERENCES } from "@blast/core/modules/social/contracts/settings.ts";
import type { SocialNotification } from "@blast/core/modules/social/contracts/notifications.ts";
import { filledSample } from "../../../../../packages/core/test/fixtures/social/create/create-fixtures.ts";
import { SaleMarketView } from "../../../src/components/presale-pages/SaleMarket.tsx";
import { SalePriceChartView } from "../../../src/components/presale-pages/SalePriceChart.tsx";
import { SaleView } from "../../../src/components/presale-pages/SaleView.tsx";
import { cx } from "../../../src/components/presale-pages/cx.ts";
import { fixtureMarket } from "../presale-pages/market-fixtures.ts";
import { FIXTURE_NOW, fixtureDetail } from "../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts";
import { proofHistory, proofMarket } from "./redesign-fixtures.ts";

/**
 * Visual proof for the redesign data gaps' page surfaces: the Settings
 * switch "Up since your call", a `call_up` notification row beside the other
 * kinds, Create's cover note read from a stored cover's upload size after
 * a reload, the coin page's market tiles with Liquidity (in the price chart's card, as production draws them;
 * `?volume=coins` gives a volume no trade of which was priced), and an open sale's page (its Momentum tiles).
 * Production views with invented data, inside the page wrapper production gives them; `?surface=` picks one and
 * `?theme=` the theme. No read, write or send path.
 */
const noop = () => undefined;
const noSubscription = () => () => {};
const param = (name: string, fallback: string) => () => new URLSearchParams(window.location.search).get(name) ?? fallback;
const NOW = Date.now();
const MINUTE = 60_000;
const presale = (symbol: string, name: string) => ({ presale_id: `0x${symbol.toLowerCase().padEnd(64, "0").slice(0, 64).replace(/[^0-9a-f]/g, "a")}`, name, symbol, icon_url: "" });
const NOTIFICATIONS: readonly SocialNotification[] = [
  { id: "3", kind: "call_up", title: "WAL is up 100% since your call", sub: "Called at $0.3100 · now $0.6240", occurred_at_ms: NOW - 4 * MINUTE, read: false, href: "/presale/wal", presale: presale("WAL", "Walrus"), actor: null },
  { id: "2", kind: "fill", title: "Meridian is 80% filled", sub: "You have 1,000 SUI in · 1d 4h left", occurred_at_ms: NOW - 60 * MINUTE, read: false, href: "/presale/mrdn", presale: presale("MRDN", "Meridian"), actor: null },
  { id: "1", kind: "funded", title: "Lumen is funded", sub: "Trading opens soon", occurred_at_ms: NOW - 6 * 60 * MINUTE, read: true, href: "/presale/lumn", presale: presale("LUMN", "Lumen"), actor: null },
];

function readyCreate() {
  createStore.reset({
    phase: "ready",
    draftId: "00000000-0000-4000-8000-0000000000f1",
    version: 1,
    fees: CREATE_DEFAULT_FEE_POLICY,
    cetusTiers: { [CREATE_QUOTE_TYPE]: [[200, 10_000]], [CREATE_SUI_QUOTE_TYPE]: [[200, 10_000]] },
    bluefinOptions: { status: "ready", min_tick: -443_636, max_tick: 443_636 },
    publish: { available: false, reasons: ["presale_not_deployed"] },
    selfAddress: "0x3f9a8c21d04b7e91a2c5f6e8b3d0794c1e2a5b6f8d9c0e1f2a3b4c5d6e7b1c21",
    nowMs: NOW,
    draft: filledSample(),
    step: "details",
    // A cover saved earlier from a 1500 × 500 upload: after a reload its note still says so.
    cover: { url: "/social-card.png", width: 1_536, height: 512, source: { width: 1_500, height: 500 } },
  });
  return createStore.get();
}

function MarketSurface({ coinsVolume }: Readonly<{ coinsVolume: boolean }>) {
  const coin = fixtureMarket();
  const history = proofHistory(coin.coin_type, true);
  const volume = coinsVolume
    ? [
        { quote_type: coin.quote.type, quote_symbol: coin.quote.symbol, quote_decimals: coin.quote.decimals, atoms: "31700000000000", usd: null, usd_complete: false },
        { quote_type: "0x2::sui::SUI", quote_symbol: "SUI", quote_decimals: 9, atoms: "400000000000000", usd: null, usd_complete: false },
      ]
    : [{ quote_type: coin.quote.type, quote_symbol: coin.quote.symbol, quote_decimals: coin.quote.decimals, atoms: "31700000000000", usd: "31700000.00", usd_complete: true }];
  return (
    <div className={cx("sale-page coin-page")}>
      <SaleMarketView
        coin={coin}
        market={proofMarket(coin.coin_type)}
        liquidity={null}
        asOf={{ checkpoint: 1, timestamp_ms: NOW, lag_ms: 0 }}
        volume={volume}
        nowMs={NOW}
        loading={false}
        failed={false}
        onRetry={noop}
        chart={(extras) => <SalePriceChartView history={history} loading={false} window="24h" onWindow={noop} trade={null} note={extras.note} />}
      />
    </div>
  );
}

function Surface({ surface, volume }: Readonly<{ surface: string; volume: string }>) {
  if (surface === "market") return <MarketSurface coinsVolume={volume === "coins"} />;
  if (surface === "presale") return <SocialViewerProvider signedIn={false} sessionPending={false}><SaleView detail={fixtureDetail("mrdn")} nowMs={FIXTURE_NOW} viewerEntry={null} /></SocialViewerProvider>;
  if (surface === "notifications") return <NotificationsView items={NOTIFICATIONS} mode="list" nowMs={NOW} />;
  if (surface === "create") {
    return (
      <SocialViewerProvider signedIn sessionPending={false}>
        <CreateView onList={noop} onLogo={noop} onRetry={noop} signIn={<a href="/sign-in">Sign in</a>} state={readyCreate()} />
      </SocialViewerProvider>
    );
  }
  return (
    <SettingsView
      callsign="kaimoreno" celebrate explorer="suiscan" mode="account"
      onCelebrate={noop} onCopy={noop} onExplorer={noop} onLinkWallet={noop}
      onLogOut={noop} onNotification={noop} onPrivate={noop} onPublicPortfolio={noop} onRetry={noop} onSignIn={noop}
      onSound={noop} onBlastConfirmation={noop} sound={false}
      settings={{ privacy: "public", sharing_since_ms: 1, commit_too_coin_type: null, public_portfolio: false, explorer: "suiscan", sound: true, blast_mode_confirm_actions: false, notifications: { ...DEFAULT_NOTIFICATION_PREFERENCES, unlocks: false } }}
      wallets={[{ address: "0x88e1d0a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c35c907af", kind: "slush", linked_at_ms: NOW - 86_400_000 }]}
    />
  );
}

export function DataGapsFixture() {
  // The server renders light settings; the client reads ?theme= and ?surface= without a hydration mismatch.
  const theme = useSyncExternalStore(noSubscription, param("theme", "light"), () => "light");
  const surface = useSyncExternalStore(noSubscription, param("surface", "settings"), () => "settings");
  const volume = useSyncExternalStore(noSubscription, param("volume", "priced"), () => "priced");
  return (
    <div className={`${geist.variable} ${geistMono.variable} ${bricolage.variable}`} data-blast-ui="" data-theme={theme}>
      <QueryProvider>
        <AppShell signedIn={false} viewer={null} portfolio={{ status: "unavailable" }} signInHref="/sign-in">
          <Surface surface={surface} volume={volume} />
        </AppShell>
      </QueryProvider>
    </div>
  );
}
