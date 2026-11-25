"use client";

import { SuiGrpcClient } from "@mysten/sui/grpc";
import { normalizeStructTag } from "@mysten/sui/utils";
import {
  defineBlastDeployment,
  deploymentFingerprint,
} from "@interest-protocol/blast-sdk/deployments";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type { SigningChainConfig } from "@blast/core/modules/launchpad-coin/signing-chain.ts";
import type { CoinPage } from "@blast/core/modules/launchpad-coin/contracts.ts";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { Button } from "#web/components/blast-ui/Button.tsx";

import { CoinTradeVisibility } from "#web/components/social/coins/coin-trade-visibility.ts";
import { SwapLoading } from "#web/components/social/coins/SwapLoading.tsx";
import { coinIdentity, sectionData } from "../coin/coin-view";
import { CoinTradeSignerProvider } from "./CoinTradeSignerProvider";
import type { LaunchpadChain } from "../transaction/preflight";
import type { ActionController } from "../transaction/controller";
import { useCurvePayment } from "./CurvePayment";
import { CurveTradeProvider, useCurveTrade, type CurveTradeSession } from "./CurveTradeProvider";
import { indicativeEstimate } from "./curve-trade-rail-model";
import { CurveTradeFill } from "./CurveTradeFill";
import type { TradeAvailability } from "./server-availability";
import { TradeRail } from "./TradeRail";
import {
  sessionHeld,
  targetKey,
  tradeTarget,
  type TradeTarget,
} from "./trade-session.ts";
import { atomsGrouped } from "@blast/core/web/format.ts";

export type CoinTradeConnection = Readonly<{
  privyAppId: string | null;
  nonce: string;
  migrationPosition: string | null;
}>;
const TradeOutlet = createContext<ReactNode>(null);

/** Only the rail is conditional. Its signer and active controllers live above CoinExecution. */
export function CoinTrade() {
  return <>{use(TradeOutlet)}</>;
}

export function CoinTradeExecution({
  page,
  availability,
  connection,
  children,
}: Readonly<{
  page: CoinPage;
  availability: TradeAvailability;
  connection: CoinTradeConnection;
  children: ReactNode;
}>) {
  const config =
    availability.status === "available" ? availability.config : null;
  const [retainedConfig, setRetainedConfig] = useState(config);
  if (!retainedConfig && config) setRetainedConfig(config);
  if (!retainedConfig) return children;
  return (
    <ConnectedExecution
      page={page}
      config={retainedConfig}
      enabled={
        config !== null &&
        deploymentFingerprint(defineBlastDeployment(config.manifest)) ===
          deploymentFingerprint(defineBlastDeployment(retainedConfig.manifest))
      }
      connection={connection}
    >
      {children}
    </ConnectedExecution>
  );
}

function ConnectedExecution({
  page,
  config,
  enabled,
  connection,
  children,
}: Readonly<{
  page: CoinPage;
  config: SigningChainConfig;
  enabled: boolean;
  connection: CoinTradeConnection;
  children: ReactNode;
}>) {
  const router = useRouter();
  const chain = useLaunchpadChain(config);
  const target = tradeTarget(page.availability, page.launchId);
  const [active, setActive] = useState<TradeTarget | null>(target);
  const refresh = useCallback(() => router.refresh(), [router]);
  if (!active && target) setActive(target);
  const execution = { target, enabled, fallback: children, setActive };
  return (
    <CoinTradeSignerProvider
      privyAppId={connection.privyAppId}
      nonce={connection.nonce}
      network={config.network}
    >
      {active?.kind === "curve" ? (
        <CurveTradeProvider
          key="curve"
          chain={chain}
          launchId={page.launchId}
          coinIconUrl={sectionData(page.curve)?.launch.metadata?.iconUrl ?? null}
          onInvalidate={refresh}
        >
          <CurveSession active={active} execution={execution} />
        </CurveTradeProvider>
      ) : active ? (
        <GraduatedSession
          key={page.launchId}
          page={page}
          active={enabled && targetKey(active) === targetKey(target)}
        >
          {children}
        </GraduatedSession>
      ) : (
        children
      )}
    </CoinTradeSignerProvider>
  );
}

type Execution = Readonly<{
  target: TradeTarget | null;
  enabled: boolean;
  fallback: ReactNode;
  setActive(target: TradeTarget): void;
}>;

function gatedController<Input>(
  controller: ActionController<Input>,
  enabled: boolean,
): ActionController<Input> {
  return {
    ...controller,
    submit: (options) => {
      if (enabled) controller.submit(options);
    },
    chooseSigner: (kind) => {
      if (enabled) controller.chooseSigner(kind);
    },
    approve: (review) => {
      if (enabled) controller.approve(review);
    },
  };
}

function useExecution<Input>(
  {
    controllers,
  }: Readonly<{
    controllers: Readonly<{
      buy: ActionController<Input>;
      sell: ActionController<Input>;
    }>;
  }>,
  active: TradeTarget,
  execution: Execution,
) {
  const buy = useSyncExternalStore(
    controllers.buy.subscribe,
    controllers.buy.getState,
    controllers.buy.getState,
  );
  const sell = useSyncExternalStore(
    controllers.sell.subscribe,
    controllers.sell.getState,
    controllers.sell.getState,
  );
  const held = sessionHeld(buy, sell);
  const sameRoute = targetKey(active) === targetKey(execution.target);
  const enabled = execution.enabled && sameRoute;
  useEffect(() => {
    if (!held && !sameRoute && execution.target) {
      // react-doctor-disable-next-line react-doctor/no-pass-live-state-to-parent -- Advance the execution owner only after both retained controllers settle; replacing it sooner loses pending transaction recovery.
      execution.setActive(execution.target);
    }
  }, [held, sameRoute, execution]);
  return {
    enabled,
    recovery: held && !enabled,
    controllers: {
      buy: gatedController(controllers.buy, enabled),
      sell: gatedController(controllers.sell, enabled),
    },
  };
}

function ExecutionOutlet({
  rail,
  recovery,
  children,
}: Readonly<{ rail: ReactNode; recovery: boolean; children: ReactNode }>) {
  return (
    <TradeOutlet value={recovery ? null : rail}>
      {recovery ? (
        <section aria-label="Unresolved trade">{rail}</section>
      ) : null}
      {children}
    </TradeOutlet>
  );
}

function CurveSession({
  active,
  execution,
}: Readonly<{ active: TradeTarget; execution: Execution }>) {
  const session = useCurveTrade();
  const gate = useExecution(session, active, execution);
  const rail = useCurveRail(session, gate);
  return (
    <ExecutionOutlet rail={rail} recovery={gate.recovery}>
      {execution.fallback}
    </ExecutionOutlet>
  );
}

/** One node client per mounted execution, built from the server's signing config. */
function useLaunchpadChain(config: SigningChainConfig): LaunchpadChain {
  const [chain] = useState<LaunchpadChain>(() => ({
    client: new SuiGrpcClient({
      network: config.network,
      baseUrl: config.baseUrl,
      format: "text",
    }),
    manifest: config.manifest,
    mode: config.mode,
  }));
  return chain;
}

/** The curve's buy and sell rail for the session's launch: buys pay with any wallet coin through the curve payment route. */
function useCurveRail(
  session: CurveTradeSession,
  gate: Readonly<{ enabled: boolean; controllers: CurveTradeSession["controllers"] }>,
): ReactNode {
  const curve = session.curve.status === "ok" ? session.curve.curve : null;
  const buy = useSyncExternalStore(session.controllers.buy.subscribe, session.controllers.buy.getState, session.controllers.buy.getState);
  const payment = useCurvePayment(session, curve, buy, gate.enabled);
  const controllers = { ...gate.controllers, buy: { ...gate.controllers.buy, submit: (options?: Parameters<ActionController<unknown>["submit"]>[0]) => {
    if (!payment.ready) return;
    session.controllers.buy.edit({ ...session.controllers.buy.getState().input, payment: payment.payment });
    gate.controllers.buy.submit(options);
  } } };
  return (
    <TradeRail
      session={{ ...session, controllers }}
      asset={
        curve && {
          symbol: curve.symbol,
          decimals: curve.decimals,
          quote: curve.quote,
        }
      }
      ready={gate.enabled && curve?.launch.lifecycle === "Live"}
      reading={session.curve.status === "reading"}
      problem={
        session.curve.status === "unavailable" ? session.curve.message : null
      }
      paymentControl={payment.control}
      paymentNote={payment.note}
      payAsset={payment.payAsset}
      payBalance={payment.payBalance}
      paymentReady={payment.ready}
      estimate={(input, direction) => {
        if (!curve) return null;
        const funding = direction === "buy" ? payment.funding : undefined;
        if (funding === null) return null;
        return indicativeEstimate(curve, funding ? { ...input, amount: atomsGrouped(BigInt(funding), curve.quote.decimals) } : input, direction);
      }}
      receipt={(digest) => {
        const trade = session.completed[digest];
        return trade && trade !== "unavailable" && curve
          ? <><CurveTradeFill trade={trade} curve={curve} iconUrl={session.coinIconUrl} />.</>
          : null;
      }}
    />
  );
}

/**
 * The coin page's curve rail for one launch outside the coin page (Blast
 * mode's coin panel), signing with the shell's session. While `live` is false
 * (the launch left its curve) `fallback` shows, except while a trade is still
 * unresolved: the rail stays until it settles, so its recovery is never lost.
 * `onMigrated` fires once the rail's own curve read sees the launch migrated.
 */
export function StandaloneCurveTrade({
  config,
  connection,
  launchId,
  coinType,
  live,
  onInvalidate,
  onMigrated,
  fallback,
}: Readonly<{
  config: SigningChainConfig;
  connection: Pick<CoinTradeConnection, "privyAppId" | "nonce">;
  launchId: string;
  /** The panel's coin: a launch that mints another coin never gets a rail under its header. */
  coinType: string;
  live: boolean;
  onInvalidate: () => void;
  onMigrated: () => void;
  fallback: ReactNode;
}>) {
  const chain = useLaunchpadChain(config);
  return (
    <CoinTradeSignerProvider
      privyAppId={connection.privyAppId}
      nonce={connection.nonce}
      network={config.network}
    >
      <CurveTradeProvider chain={chain} launchId={launchId} onInvalidate={onInvalidate}>
        <StandaloneCurveSession coinType={coinType} live={live} onMigrated={onMigrated} fallback={fallback} />
      </CurveTradeProvider>
    </CoinTradeSignerProvider>
  );
}

function StandaloneCurveSession({
  coinType,
  live: listed,
  onMigrated,
  fallback,
}: Readonly<{ coinType: string; live: boolean; onMigrated: () => void; fallback: ReactNode }>) {
  const session = useCurveTrade();
  const mismatched = session.curve.status === "ok" && !sameCoinType(session.curve.curve.launch.memeType, coinType);
  const live = listed && !mismatched;
  const { buy, sell } = session.controllers;
  const buyState = useSyncExternalStore(buy.subscribe, buy.getState, buy.getState);
  const sellState = useSyncExternalStore(sell.subscribe, sell.getState, sell.getState);
  const held = sessionHeld(buyState, sellState);
  const rail = useCurveRail(session, {
    enabled: live,
    controllers: { buy: gatedController(buy, live), sell: gatedController(sell, live) },
  });
  const migrated = session.curve.status === "ok" && session.curve.curve.launch.lifecycle === "Migrated";
  const migratedRef = useRef(onMigrated);
  useEffect(() => {
    migratedRef.current = onMigrated;
  }, [onMigrated]);
  useEffect(() => {
    if (migrated) migratedRef.current();
  }, [migrated]);
  return live || (held && !mismatched) ? rail : fallback;
}

function sameCoinType(a: string, b: string): boolean {
  try {
    return normalizeStructTag(a) === normalizeStructTag(b);
  } catch {
    return false;
  }
}

function GraduatedSession({ page, active, children }: Readonly<{
  page: CoinPage;
  active: boolean;
  children: ReactNode;
}>) {
  const router = useRouter();
  const current = coinIdentity(page);
  const known = current.coinType !== null && current.memeDecimals !== null;
  const [identity, setIdentity] = useState(known ? current : null);
  if (!identity && known) setIdentity(current);
  const rail = identity && identity.coinType && identity.memeDecimals !== null ? (
    <GraduatedCoinTrade
      key={identity.coinType}
      active={active && known}
      coinType={identity.coinType}
      name={identity.name ?? identity.symbol}
      symbol={identity.symbol}
      decimals={identity.memeDecimals}
      iconUrl={identity.iconUrl}
    />
  ) : (
    <EmptyState title="Trading couldn't load" role="alert" action={<Button onClick={() => router.refresh()}>Try again</Button>}>
      The coin details could not be read. Try again shortly.
    </EmptyState>
  );
  return <ExecutionOutlet rail={rail} recovery={false}>{children}</ExecutionOutlet>;
}


/** The graduated coin's swap panel, on its own chunk (the wallet kit and signers load with it, not with the page). */
const CoinsHost = dynamic(() => import("#web/components/social/coins/CoinsHost.tsx").then((module) => module.CoinsHost), {
  loading: () => <SwapLoading />,
});

export function GraduatedCoinTrade({ active = true, coinType, name, symbol, decimals, iconUrl }: Readonly<{
  active?: boolean; coinType: string; name: string; symbol: string; decimals: number; iconUrl: string | null;
}>) {
  const visible = use(CoinTradeVisibility);
  return <CoinsHost active={active && visible} inlineTrade={{ side: "buy", coin: {
    coin_type: coinType, name, symbol, decimals, icon_url: iconUrl, usd_price: null, presale_id: null,
  } }} />;
}
