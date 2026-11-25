"use client";

import { createContext, use, useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { defineBlastDeployment, type BlastDeployment } from "@interest-protocol/blast-sdk/deployments";


import { reportVerifiedOutcome, type VerifiedOutcomeReport } from "#web/modules/launchpad-telemetry/client.ts";
import type { OutcomeReport } from "@blast/core/modules/launchpad-telemetry/contracts.ts";

import type { ActionController } from "../transaction/controller";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { invalidateAfter } from "#web/lib/query/invalidate.ts";
import { useFeelSound } from "#web/components/blast-feel/FeelProvider.tsx";
import { hasActiveToast } from "#web/components/blast-ui/toast-actions.ts";
import { useBalancesContext } from "#web/components/social/coins/balances.tsx";
import { useCoinTradeWallet } from "./CoinTradeSignerProvider";
import { useLaunchpadSigners } from "../transaction/LaunchpadSignerProvider";
import { useCaptureSignerToast } from "../transaction/use-capture-signer-toast";
import type { LaunchpadChain } from "../transaction/preflight";

import { CurveTradeFill } from "./CurveTradeFill";
import { curveTradeToast, type CompletedTrade } from "./completed-trade";
import { explorerTransactionUrl } from "../transaction/explorer";
import type { CurveTradeInput, TradeDirection } from "./curve-adapter";
import { readCurve, type CurveRead } from "./curve-read";
import { tradeLedger, type CurveDiagnostic, type TradeLedger } from "./diagnostics";

import { reportCurveToAnalytics, createCurveTradeControllers, watchCurveTrades, curveCompletionHandler, gateWhileUnresolved } from "./curve-trade-provider-model";
import { noteOwnTrade } from "../chart/chart-live-price";

type Balances = Readonly<{ quote: bigint; meme: bigint }> | null;

export type CurveTradeSession = Readonly<{
  chain: LaunchpadChain;
  /** The accepted deployment the trades build against; aborts are read only from its launchpad package. */
  deployment: BlastDeployment;
  launchId: string;
  coinIconUrl?: string | null;
  /** The last curve read: `reading` until the first answer. */
  curve: CurveRead | Readonly<{ status: "reading" }>;
  /** The connected wallet's balances, once a wallet is connected. */
  balances: Balances;
  balancesPending?: boolean;
  refresh(): void;
  direction: TradeDirection;
  setDirection(direction: TradeDirection): void;
  /** Both directions' controllers, gated by `gateWhileUnresolved`: nothing new starts while a trade is unresolved. */
  controllers: Readonly<Record<TradeDirection, ActionController<CurveTradeInput>>>;
  /** What a completed trade's event said, by digest. */
  completed: Readonly<Record<string, CompletedTrade | "unavailable">>;
}>;

const Session = createContext<CurveTradeSession | null>(null);

export function useCurveTrade(): CurveTradeSession {
  const session = use(Session);
  if (!session) throw new Error("useCurveTrade needs a CurveTradeProvider.");
  return session;
}

/**
 * Owns both directions' trade controllers, the curve read, diagnostics, and
 * each Buy's verified outcome (its commitment before submission and its
 * report once completed) for one launch, above the terminal, so the trade
 * survives the rail moving between the desktop column and the mobile sheet.
 * Mount it under a `LaunchpadSignerProvider`.
 */
export function CurveTradeProvider({
  chain,
  launchId,
  coinIconUrl,
  report = reportCurveToAnalytics,
  reportOutcome = reportVerifiedOutcome,
  commitOutcome,
  ledger,
  onInvalidate,
  initialCurve,
  controllers: provided,
  children,
}: Readonly<{
  chain: LaunchpadChain;
  launchId: string;
  coinIconUrl?: string | null;
  report?: (diagnostic: CurveDiagnostic) => void;
  /** Reports a completed Buy for server verification (default `reportVerifiedOutcome`); fire-and-forget. */
  reportOutcome?: (outcome: VerifiedOutcomeReport) => void;
  /** Commits a signed Buy's digest before submission (default `commitSignedOutcome`); fixed for the provider's lifetime. */
  commitOutcome?: (outcome: OutcomeReport) => void;
  ledger?: TradeLedger;
  /** Called with the read keys a completed trade invalidates (launch, curve, chart, activity, balances). */
  onInvalidate?: (keys: readonly string[]) => void;
  /** A curve already read, for rendering without a node. */
  initialCurve?: CurveRead;
  /** Controllers already created (tests); by default the provider creates them. */
  controllers?: Readonly<Record<TradeDirection, ActionController<CurveTradeInput>>>;
  children: ReactNode;
}>) {
  const signers = useLaunchpadSigners();
  const queries = useAppQueryClient();
  const captureToast = useCaptureSignerToast(signers);
  const shellBalances = useBalancesContext();
  const wallet = useCoinTradeWallet();
  const walletIdentity = wallet?.identity ?? "standalone";
  const [deployment] = useState(() => defineBlastDeployment(chain.manifest));
  const [confirmationToasts] = useState(() => new Map<string, ReturnType<typeof captureToast>>());
  const [controllers] = useState(() => provided ?? createCurveTradeControllers({
    chain,
    signers,
    launchId,
    commitOutcome,
    captureConfirmation(direction, signer) {
      const show = captureToast(signer);
      return ({ digest, explorerUrl }) => {
        if (show(direction === "buy" ? "Buy confirmed" : "Sell confirmed", {
          href: explorerUrl ?? undefined,
          id: `curve-trade:${digest}`,
        })) confirmationToasts.set(digest, show);
      };
    },
  }));
  const [gated] = useState(() => gateWhileUnresolved(controllers));
  const [trades] = useState(() => ledger ?? tradeLedger());
  const [curve, setCurve] = useState<CurveTradeSession["curve"]>(initialCurve ?? { status: "reading" });
  const [refreshes, setRefreshes] = useState(0);
  const [balanceRead, setBalanceRead] = useState<Readonly<{ identity: string; value: Balances }> | null>(null);
  const balanceKey = `${walletIdentity}:${refreshes}`;
  const balances = balanceRead?.identity === balanceKey ? balanceRead.value : null;
  const balancesPending = Boolean(wallet?.identity && balanceRead?.identity !== balanceKey);
  const [direction, setDirection] = useState<TradeDirection>("buy");
  const [completed, setCompleted] = useState<CurveTradeSession["completed"]>({});
  const refresh = useCallback(() => setRefreshes((count) => count + 1), []);
  const curveRef = useRef(curve);
  useEffect(() => {
    if (curve.status === "ok") curveRef.current = curve;
  }, [curve]);

  // The curve (and, once a wallet is connected, its balances) read fresh from the node.
  useEffect(() => {
    let current = true;
    void readCurve(chain.client, deployment, launchId, Date.now()).then(async (read) => {
      if (!current) return;
      setCurve(read);
      setBalanceRead(null);
      const signer = signers.current();
      if (!signer || read.status !== "ok") return;
      try {
        const [quote, coin] = await Promise.all([
          chain.client.core.getBalance({ owner: signer.address, coinType: read.curve.launch.quoteType }),
          chain.client.core.getBalance({ owner: signer.address, coinType: read.curve.launch.memeType }),
        ]);
        if (current) setBalanceRead({ identity: balanceKey, value: { quote: BigInt(quote.balance.balance), meme: BigInt(coin.balance.balance) } });
      } catch {
        if (current) setBalanceRead({ identity: balanceKey, value: null });
      }
    });
    return () => {
      current = false;
    };
  }, [chain, deployment, launchId, refreshes, signers, balanceKey]);

  // A completed trade invalidates every affected read: this rail refreshes its own, the page the rest.
  const invalidateRef = useRef(onInvalidate);
  const balancesRef = useRef(shellBalances);
  useEffect(() => {
    balancesRef.current = shellBalances;
    invalidateRef.current = onInvalidate;
  }, [onInvalidate, shellBalances]);
  useEffect(() => {
    const stops = (["buy", "sell"] as const).map((key) =>
      controllers[key].onInvalidate((keys, checkpoint) => {
        if (checkpoint !== null) noteOwnTrade(launchId, checkpoint);
        refresh();
        invalidateRef.current?.(keys);
        void invalidateAfter(queries, { kind: "trade" }).catch(() => {});
        void Promise.resolve().then(() => balancesRef.current.changed()).catch(() => {});
      }),
    );
    return () => stops.forEach((stop) => stop());
  }, [controllers, refresh, queries, launchId]);

  // Diagnostics from each controller's state changes; completion, and a completed Buy's verified
  // outcome, only from the completed event.
  const { play } = useFeelSound();
  const reportRef = useRef(report);
  const outcomeRef = useRef(reportOutcome);
  useEffect(() => {
    reportRef.current = report;
    outcomeRef.current = reportOutcome;
  }, [report, reportOutcome]);
  useEffect(() => {
    const readCompletion = curveCompletionHandler({
      client: chain.client,
      deployment,
      launchId,
      ledger: trades,
      // The receipt and verified Buy report still use the completed event.
      decimals: (key) => {
        const read = curveRef.current;
        return key === "buy" ? (read.status === "ok" ? read.curve.decimals : null) : (read.status === "ok" ? read.curve.quote.decimals : null);
      },
      signer: () => signers.current(),
      reportOutcome: (outcome) => outcomeRef.current(outcome),
      onRead: (digest, read) => {
        setCompleted((entries) => ({ ...entries, [digest]: read }));
        if (read !== "unavailable") play({ kind: read.kind === "Bought" ? "buy" : "sell" });
        const show = confirmationToasts.get(digest);
        confirmationToasts.delete(digest);
        const id = `curve-trade:${digest}`;
        const latestCurve = curveRef.current;
        if (show && read !== "unavailable" && latestCurve.status === "ok" && hasActiveToast(id)) {
          const { title, options } = curveTradeToast(read, latestCurve.curve, explorerTransactionUrl(deployment, digest));
          show(title, { ...options, id, titleContent: <CurveTradeFill trade={read} curve={latestCurve.curve} iconUrl={coinIconUrl} /> });
        }
      },
    });
    return watchCurveTrades(controllers, {
      deployment,
      report: (diagnostic) => reportRef.current(diagnostic),
      refresh,
      onCompleted: readCompletion,
    });
  }, [chain, coinIconUrl, confirmationToasts, controllers, deployment, launchId, play, refresh, signers, trades]);

  return (
    <Session
      value={{ chain, deployment, launchId, coinIconUrl, curve, balances, balancesPending, refresh, direction, setDirection, controllers: gated, completed }}
    >
      {children}
    </Session>
  );
}
