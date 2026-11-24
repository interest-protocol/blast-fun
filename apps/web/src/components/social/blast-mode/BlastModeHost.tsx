"use client";

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";

import type { PanelSetup } from "@blast/core/modules/social/blast-workspace/setup.ts";
import { WorkspacePending } from "./workspace/WorkspacePending";
import { useShellAction } from "#web/components/blast-ui/shell-actions.tsx";
import type { SocialAccountState } from "../social-account-client";
import type { SocialAccountSessionStatus } from "../use-social-account-session";
import { BlastActionProvider } from "./workspace/BlastActionProvider";
import { CurveTradeSetupContext } from "./workspace/curve-trade-context";
import type { CurveTradeSetup } from "#web/components/launchpad/trade/server-availability.ts";
import { WorkspaceFrame } from "./WorkspaceFrame";
import { workspaceSession } from "./workspace/session";
import {
  workspaceOwnerFromSession,
  workspaceEntryOwner,
} from "./workspace/entry-owner";
import type {
  WorkspaceOwner,
  WorkspaceOwnerResolver,
} from "./workspace/workspace-context";
import type { WorkspaceSlots } from "./workspace/WorkspaceHost";

const WorkspaceHost = lazy(() =>
  import("./workspace/WorkspaceHost").then((module) => ({
    default: module.WorkspaceHost,
  })),
);
const WorkspaceCoinPanel = lazy(() =>
  import("./workspace/panels/WorkspaceCoinPanel").then((module) => ({
    default: module.WorkspaceCoinPanel,
  })),
);
const WorkspacePresalePanel = lazy(() =>
  import("./workspace/panels/WorkspacePresalePanel").then((module) => ({
    default: module.WorkspacePresalePanel,
  })),
);
const CoinsData = lazy(() =>
  import("./workspace/CoinsData").then((module) => ({
    default: module.CoinsData,
  })),
);
const PresalesData = lazy(() =>
  import("./workspace/PresalesData").then((module) => ({
    default: module.PresalesData,
  })),
);
const TradersData = lazy(() =>
  import("./workspace/TradersData").then((module) => ({
    default: module.TradersData,
  })),
);
const ActivityData = lazy(() =>
  import("./workspace/ActivityData").then((module) => ({
    default: module.ActivityData,
  })),
);
const BondingData = lazy(() =>
  import("./workspace/BondingData").then((module) => ({
    default: module.BondingData,
  })),
);
const FeedData = lazy(() =>
  import("./workspace/FeedData").then((module) => ({
    default: module.FeedData,
  })),
);
const PortfolioData = lazy(() =>
  import("./workspace/PortfolioData").then((module) => ({ default: module.PortfolioData })),
);
const WorkspaceSignals = lazy(() => import("./workspace/WorkspaceSignals").then(module => ({ default: module.WorkspaceSignals })));
const defaultSlots: WorkspaceSlots = {
  discovery: WorkspaceSignals,
  panel: DefaultWorkspacePanel,
  data: {
    Coins: CoinsData,
    Presales: PresalesData,
    Bonding: BondingData,
    Traders: TradersData,
    Activity: ActivityData,
    Feed: FeedData,
    Portfolio: PortfolioData,
  },
};
function DefaultWorkspacePanel({
  panel,
}: Readonly<{ panel: PanelSetup }>) {
  return panel.active_namespace === "presale" ? (
    <WorkspacePresalePanel panel={panel} />
  ) : (
    <WorkspaceCoinPanel panel={panel} />
  );
}
const subscribe = (listener: () => void) =>
  workspaceSession().subscribe(listener);
const snapshot = () => workspaceSession().getSnapshot();
const closed = {
  open: false,
  generation: 0,
  origin: null,
  durable: true,
} as const;
const serverSnapshot = () => closed;

type AccountSession = SocialAccountState & {
  sessionStatus?: SocialAccountSessionStatus;
  sessionIdentity?: string;
};

/** Capture the entry's principal with its owner; new auth cannot inherit a private entry. */
function useEntryOwner(
  state: Readonly<{ open: boolean; generation: number }>,
  accountState?: AccountSession,
) {
  const [entry, setEntry] = useState<{
    generation: number;
    owner: WorkspaceOwner | null;
    sessionIdentity?: string;
  }>({ generation: -1, owner: null });
  const current =
    state.open && entry.generation === state.generation
      ? entry
      : { generation: state.generation, owner: null };
  const currentOwner = accountState
    ? workspaceOwnerFromSession(accountState)
    : { status: "error" as const };
  const selected = workspaceEntryOwner(current.owner, currentOwner, {
    entry: current.sessionIdentity,
    current: accountState?.sessionIdentity,
  });
  if (state.open && selected.status === "ready" && !current.owner) {
    setEntry({
      generation: state.generation,
      owner: selected.owner,
      sessionIdentity: accountState?.sessionIdentity,
    });
  } else if (
    entry.generation !== current.generation ||
    (!state.open && entry.owner)
  ) {
    setEntry(current);
  }
  return selected;
}

/** One global lazy screen. The current route stays mounted under its portal. */
export function BlastModeHost({
  accountState,
  resolveOwner: suppliedResolver,
  ownerKey: suppliedKey,
  slots,
  onRetryOwner,
  getAccessToken,
  curveTrade = null,
}: Readonly<{
  accountState?: AccountSession;
  resolveOwner?: WorkspaceOwnerResolver;
  ownerKey?: string;
  slots?: WorkspaceSlots;
  /** The request's curve trading setup: a coin panel buys a live bonding-curve coin with the coin page's rail. */
  curveTrade?: CurveTradeSetup | null;
  onRetryOwner?: () => void;
  getAccessToken?: import("../social-fetch").AccessTokenSource;
}>) {
  const pathname = usePathname();
  const previousPath = useRef(pathname);
  const state = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const selected = useEntryOwner(state, accountState);
  const entryOwner = selected.status === "ready" ? selected.owner : null;
  const selectionKey =
    entryOwner?.kind === "account"
      ? `account:${entryOwner.account_id}`
      : (entryOwner?.kind ?? selected.status);
  const close = useCallback(() => workspaceSession().close(), []);
  const toggle = useCallback(() => {
    const current = workspaceSession();
    if (document.querySelector('dialog[open], [aria-modal="true"]')) return;
    if (current.getSnapshot().open) {
      current.close();
      return;
    }
    current.open({
      path:
        window.location.pathname +
        window.location.search +
        window.location.hash,
      scroll_x: window.scrollX,
      scroll_y: window.scrollY,
      main_scroll_top: document.getElementById("main")?.scrollTop ?? 0,
    });
  }, []);
  useShellAction("toggleBlastMode", toggle);
  useEffect(() => {
    if (!suppliedResolver && selected.status === "ended") close();
  }, [close, selected.status, suppliedResolver]);
  useEffect(() => {
    if (previousPath.current !== pathname) close();
    previousPath.current = pathname;
  }, [close, pathname]);
  const resolveOwner = useCallback<WorkspaceOwnerResolver>(
    async (signal) => {
      if (!accountState) throw new Error("Workspace identity is unavailable");
      const selected = workspaceEntryOwner(
        entryOwner,
        workspaceOwnerFromSession(accountState),
      );
      if (selected.status === "ready") return selected.owner;
      if (selected.status === "error" || selected.status === "ended")
        throw new Error("Workspace identity check failed");
      return new Promise((_, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(new Error("Identity read cancelled")),
          { once: true },
        ),
      );
    },
    [accountState, entryOwner],
  );
  if (
    (!suppliedResolver && selected.status === "ended") ||
    !state.open ||
    typeof document === "undefined"
  )
    return null;
  return createPortal(
    <Suspense
      fallback={
        <WorkspaceFrame onExit={close} origin={state.origin}>
          <WorkspacePending />
        </WorkspaceFrame>
      }
    >
      <BlastActionProvider accountState={accountState} getAccessToken={getAccessToken}>
      <CurveTradeSetupContext value={curveTrade}>
      <WorkspaceHost
        key={state.generation}
        getAccessToken={getAccessToken}
        entryGeneration={state.generation}
        onExit={close}
        origin={state.origin}
        onRetryOwner={onRetryOwner}
        ownerKey={suppliedKey ?? selectionKey}
        resolveOwner={suppliedResolver ?? resolveOwner}
        sessionDurable={state.durable}
        slots={{
          ...defaultSlots,
          ...slots,
          data: { ...defaultSlots.data, ...slots?.data },
        }}
      />
      </CurveTradeSetupContext>
      </BlastActionProvider>
    </Suspense>,
    document.querySelector<HTMLElement>("[data-blast-ui]") ?? document.body,
  );
}
