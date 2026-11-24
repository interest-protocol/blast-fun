"use client";

import { writeBrowserStorage } from "#web/lib/browser-storage.ts";
import { Button, DisclosureButton, IconButton } from "#web/components/blast-ui/Button.tsx";
import { BlastMenu, BlastMenuTrigger, BlastMenuRadioGroup, BlastMenuRadioItem, BlastMenuRadioItemIndicator } from "#web/components/blast-ui/BlastMenu.tsx";
import { WorkspaceUndo } from "./WorkspaceUndo";
import { Segmented } from "#web/components/blast-ui/Segmented.tsx";
import {
  Suspense,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";

import { createPortal } from "react-dom";
import { normalizeStructTag } from "@mysten/sui/utils";
import { Sheet, SheetClose, SheetHeading } from "#web/components/blast-ui/Sheet.tsx";
import { SkeletonBox } from "#web/components/blast-ui/Skeleton.tsx";
import {
  useWorkspace,
  WorkspaceContext,
  type WorkspaceContextValue,
  type WorkspaceOwner,
  type WorkspaceOwnerResolver,
  type WorkspaceOwnerState,
} from "./workspace-context";
import { WorkspacePresaleDockContext } from "./presale-dock-context";
import { CloseIcon, GridIcon, PanelLeftIcon, PanelRightIcon, PlusIcon } from "#web/components/blast-ui/Icons.tsx";
import { PanelSkeleton, StripSkeleton, WorkspacePending } from "./WorkspacePending";
import { DISCOVER_CHOSEN_KEY, DISCOVER_SHEET_QUERY, discoverChosen, discoverDefaultCollapsed } from "./discover-default";
import { RowsSkeleton } from "./RowsSkeleton";
import { WorkspaceSaveStatus } from "./WorkspaceSaveStatus";
import { WorkspaceFrame } from "../WorkspaceFrame";
import { WorkspaceStatusSlot, WorkspaceToolbarTarget } from "./frame-targets";
import {
  DATA_VIEWS,
  type DataView,
  type Network,
  type PanelSetup,
  type PanelInput,
  type WorkspaceV1,
} from "@blast/core/modules/social/blast-workspace/setup.ts";
import type { JournalResult, JournalStorage } from "./journal";
import { createWorkspaceStore, type WorkspaceStore } from "./model";
import {
  createAccountWorkspace,
} from "./account-sync";
import { createWorkspaceApi } from "./account-api";
import type { AccessTokenSource } from "../../social-fetch";
import { guestWorkspaceJournal } from "./guest-journal";
import styles from "./WorkspaceHost.module.css";
import { WorkspaceTradeDockContext } from "./workspace-trade-dock-context";
import { presaleHistory } from "./presale-history";
import { workspaceScrollOwner } from "./scroll-owner";
import { PanelSortProvider, TrackedPanel } from "./TrackedPanels";
import { DataViewIcon } from "./data-view-icons";
import { dataViewLabel, PRIMARY_DATA_VIEWS } from "./data-view-label";
import { escapeInDiscover } from "./discover-escape";
import { createDiscoveryPreview, discoveryPreviewKey, DiscoveryPreviewContext } from "./discovery-preview";
import { CollapsedDiscoveryIcons } from "./CollapsedDiscoveryIcons";
import { AssetChoice } from "./PanelMark";
import { PanelDock, WorkspaceSearch } from "./PanelDock";
import { WorkspacePortfolio } from "./WorkspacePortfolio";
import { AccountBalance } from "#web/components/blast-ui/AccountBalance.tsx";
import { useShellPrefs } from "#web/components/blast-ui/use-shell-prefs.ts";
import { useShellPortfolioContext } from "../../shell-portfolio-context";
import { useCurrentBlastAccount } from "./BlastActionProvider";
import { coinTypeIdentity, createPanelIdentities, PanelIdentitiesContext } from "./panel-identities";
import { dyn } from "#web/components/blast-ui/csp-style.ts";
import type { WorkspaceOrigin } from "./session";
import { compareAvailablePageSize, comparePage, comparePageSize } from "./compare-layout";
import { WorkspaceLayoutProvider, WorkspaceLayoutTools } from "./WorkspaceLayout";
import { WorkspaceShortcuts } from "./WorkspaceShortcuts";
import { openWorkspaceSearch } from "./workspace-search";
import { TestPricingNotice } from "#web/components/social/TestPricingNotice.tsx";
import { useTestPricing } from "#web/components/social/test-pricing-context.tsx";
import { rememberWorkspacePreview } from "./workspace-preview";

/** A failed or unresolved identity never selects guest storage. */
export function useWorkspaceOwner(
  resolveOwner: WorkspaceOwnerResolver,
  ownerKey: string,
) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Readonly<{
    key: string;
    attempt: number;
    state: WorkspaceOwnerState;
  }> | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void resolveOwner(controller.signal).then(
      (owner) => {
        if (!controller.signal.aborted)
          setResult({
            key: ownerKey,
            attempt,
            state: { status: "ready", owner },
          });
      },
      () => {
        if (!controller.signal.aborted)
          setResult({ key: ownerKey, attempt, state: { status: "error" } });
      },
    );
    return () => controller.abort();
  }, [attempt, ownerKey, resolveOwner]);
  const state: WorkspaceOwnerState =
    result?.key === ownerKey && result.attempt === attempt
      ? result.state
      : { status: "pending" };
  return { ...state, retry: () => setAttempt((value) => value + 1) };
}

export type WorkspaceSlots = Readonly<{
  panel?: ComponentType<Readonly<{ panel: PanelSetup }>>;
  data?: Partial<Record<DataView, ComponentType>>;
  controls?: ReactNode;
  discovery?: ComponentType;
}>;
export type WorkspaceHostProps = Readonly<{
  resolveOwner: WorkspaceOwnerResolver;
  ownerKey: string;
  entryGeneration: number;
  onExit: () => void;
  network?: Network;
  storage?: JournalStorage;
  slots?: WorkspaceSlots;
  sessionDurable?: boolean;
  origin?: WorkspaceOrigin | null;
  onRetryOwner?: () => void;
  getAccessToken?: AccessTokenSource;
}>;

export function WorkspaceHost({
  resolveOwner,
  ownerKey,
  entryGeneration,
  onExit,
  network = "mainnet",
  storage,
  slots,
  sessionDurable = true,
  origin,
  onRetryOwner,
  getAccessToken,
}: WorkspaceHostProps) {
  const owner = useWorkspaceOwner(resolveOwner, ownerKey);
  return (
    <WorkspaceFrame onExit={onExit} origin={origin}>
      {!sessionDurable && (
        <p role="status">
          This tab cannot remember whether Blast mode is open after refresh.
        </p>
      )}
      {owner.status === "pending" && <WorkspacePending />}
      {owner.status === "error" && (
        <WorkspaceProblem
          message="Your session could not be checked. Your saved workspace has not been changed."
          retry={() => {
            onRetryOwner?.();
            owner.retry();
          }}
        />
      )}
      {owner.status === "ready" && (
        <WorkspaceOwnerContent
          key={ownerKey}
          owner={owner.owner}
          getAccessToken={getAccessToken}
          entryGeneration={entryGeneration}
          network={network}
          storage={storage}
          slots={slots}
        />
      )}
    </WorkspaceFrame>
  );
}

function WorkspaceProblem({
  message,
  retry,
}: Readonly<{ message: string; retry?: () => void }>) {
  return (
    <div className={styles.problem} role="alert">
      <p>{message}</p>
      {retry && (
        <Button variant="secondary" size="sm"  onClick={retry} type="button">
          Retry
        </Button>
      )}
    </div>
  );
}

function WorkspaceOwnerContent({
  owner,
  entryGeneration,
  network,
  storage,
  slots,
  getAccessToken,
}: Readonly<{
  getAccessToken?: AccessTokenSource;
  owner: WorkspaceOwner;
  entryGeneration: number;
  network: Network;
  storage?: JournalStorage;
  slots?: WorkspaceSlots;
}>) {
  if (owner.kind === "account") {
    return owner.store ? (
      <WorkspaceContent
        store={owner.store}
        owner={owner}
        entryGeneration={entryGeneration}
        slots={slots}
      />
    ) : (
      <AccountWorkspace
        accountId={owner.account_id}
        entryGeneration={entryGeneration}
        network={network}
        storage={storage}
        slots={slots}
        getAccessToken={getAccessToken}
      />
    );
  }
  return (
    <GuestWorkspace
      entryGeneration={entryGeneration}
      network={network}
      storage={storage}
      slots={slots}
    />
  );
}

function AccountWorkspace({
  accountId,
  entryGeneration,
  network,
  storage,
  slots,
  getAccessToken,
}: Readonly<{
  accountId: string;
  entryGeneration: number;
  network: Network;
  storage?: JournalStorage;
  slots?: WorkspaceSlots;
  getAccessToken?: AccessTokenSource;
}>) {
  const token = useRef(getAccessToken);
  useLayoutEffect(() => {
    token.current = getAccessToken;
  }, [getAccessToken]);
  const [controller, setController] = useState<ReturnType<
    typeof createAccountWorkspace
  > | null>(null);
  useLayoutEffect(() => {
    const abort = new AbortController();
    let writerId: string;
    try {
      writerId =
        window.sessionStorage.getItem("blast.workspace.writer:1") ??
        crypto.randomUUID();
      window.sessionStorage.setItem("blast.workspace.writer:1", writerId);
    } catch {
      writerId = crypto.randomUUID();
    }
    const local: JournalStorage = storage ?? {
      getItem: (key) => window.localStorage.getItem(key),
      setItem: (key, value) => window.localStorage.setItem(key, value),
    };
    const next = createAccountWorkspace({
      accountId,
      writerId,
      storage: local,
      network,
      api: createWorkspaceApi({
        accountId,
        signal: abort.signal,
        getAccessToken: () => token.current?.() ?? Promise.resolve(null),
      }),
      guest: () => {
        const guest = guestWorkspaceJournal(network, storage);
        return guest.restore.status === "recovery_required"
          ? null
          : guest.store.getSnapshot();
      },
    });
    // Browser journals are read after mount and never during SSR.
    setController(next);
    void next.start();
    const reconnect = () => {
      void next.retry();
    };
    const flush = () => {
      void next.flush();
    };
    window.addEventListener("online", reconnect);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("online", reconnect);
      window.removeEventListener("pagehide", flush);
      void next.flush();
      next.dispose();
      abort.abort();
    };
  }, [accountId, entryGeneration, network, storage]);
  return controller ? (
    <AccountWorkspaceContent
      controller={controller}
      accountId={accountId}
      entryGeneration={entryGeneration}
      slots={slots}
    />
  ) : (
    <WorkspacePending />
  );
}

function AccountWorkspaceContent({
  controller,
  accountId,
  entryGeneration,
  slots,
}: Readonly<{
  controller: ReturnType<typeof createAccountWorkspace>;
  accountId: string;
  entryGeneration: number;
  slots?: WorkspaceSlots;
}>) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  if (state.phase === "loading") return <WorkspacePending snapshot={state.preview} />;
  if (!state.store)
    return (
      <WorkspaceProblem
        message="Your account workspace could not load. Your saved setup has been kept. Retry to open it."
        retry={() => {
          void controller.retry();
        }}
      />
    );
  return (
    <>
      <WorkspaceSaveStatus state={state.sync} reason={state.reason} retry={() => { void controller.retry(); }} />
      <WorkspaceContent
        store={state.store}
        owner={{ kind: "account", account_id: accountId }}
        entryGeneration={entryGeneration}
        slots={slots}
      />
    </>
  );
}

function createGuestJournalSource(
  network: Network,
  storage: JournalStorage | undefined,
  attempt: number,
) {
  type GuestJournal = ReturnType<typeof guestWorkspaceJournal>;
  let revision = 0;
  let snapshot: { journal: GuestJournal; persistence: JournalResult; revision: number } | null =
    null;
  let notify = () => {};
  const update = (journal: GuestJournal) => {
    snapshot = { journal, persistence: journal.getPersistence(), revision: ++revision };
    notify();
  };
  return {
    subscribe(listener: () => void) {
      // Subscription starts after mount; browser storage is never read in render.
      const journal = guestWorkspaceJournal(network, storage, attempt > 0);
      notify = listener;
      const unsubscribe = journal.store.subscribe(() => update(journal));
      update(journal);
      return () => {
        unsubscribe();
        notify = () => {};
      };
    },
    getSnapshot: () => snapshot,
    retry() {
      if (!snapshot) return;
      snapshot.journal.flush();
      update(snapshot.journal);
    },
  };
}

function GuestWorkspace({
  entryGeneration,
  network,
  storage,
  slots,
}: Readonly<{
  entryGeneration: number;
  network: Network;
  storage?: JournalStorage;
  slots?: WorkspaceSlots;
}>) {
  const [attempt, setAttempt] = useState(0);
  const source = useMemo(
    () => createGuestJournalSource(network, storage, attempt),
    [attempt, network, storage],
  );
  const state = useSyncExternalStore(
    source.subscribe,
    source.getSnapshot,
    () => null,
  );
  if (!state) return <WorkspacePending />;
  const { journal, persistence } = state;
  if (journal.restore.status === "recovery_required") {
    return (
      <WorkspaceProblem
        message="Your saved workspace could not be read. Its stored contents have been kept. Retry when storage is available."
        retry={() => {
          setAttempt((value) => value + 1);
        }}
      />
    );
  }
  return (
    <>
      <WorkspaceSaveStatus saveRevision={state.revision} state={persistence.ok ? "synced" : "error"} reason={persistence.ok ? undefined : persistence.reason === "workspace_changed_in_another_tab" ? persistence.reason : "guest_save_failed"} retry={source.retry} />
      <WorkspaceContent
        store={journal.store}
        owner={{ kind: "guest" }}
        entryGeneration={entryGeneration}
        slots={slots}
      />
    </>
  );
}

const subscribeVisibility = (listener: () => void) => {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
};
const visible = () => document.visibilityState === "visible";
const subscribeMobile = (listener: () => void) => {
  const query = window.matchMedia(DISCOVER_SHEET_QUERY);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
};
const mobileScreen = () => window.matchMedia(DISCOVER_SHEET_QUERY).matches;
const viewportSize = () => `${window.innerWidth}:${window.innerHeight}`;
const serverViewport = () => "1414:900";
function subscribeViewport(listener: () => void) {
  window.addEventListener("resize", listener);
  return () => window.removeEventListener("resize", listener);
}
const serverFalse = () => false;


function usePresalePresentation(snapshot: WorkspaceV1, store: WorkspaceStore, mobile: boolean, documentVisible: boolean, setDataCollapsed: (collapsed: boolean) => void) {
  const [presaleRequest, setPresaleRequest] = useState<string | null>(null);
  const [presaleTarget, setPresaleTarget] = useState<HTMLDivElement | null>(null);
  const presaleTriggerRef = useRef<HTMLElement | null>(null);
  const available = !mobile || snapshot.mobile_panel_id === presaleRequest;
  const presaleId = presaleRequest && available && snapshot.visible_order.includes(presaleRequest) && snapshot.panels[presaleRequest]?.active_namespace === "presale" && !snapshot.data.collapsed ? presaleRequest : null;
  if (presaleRequest && !presaleId) setPresaleRequest(null);
  function closePresale() {
    setPresaleRequest(null);
    if (mobile) setDataCollapsed(true);
    window.requestAnimationFrame(() => {
      const trigger = presaleTriggerRef.current;
      if (trigger?.isConnected && !trigger.closest("[hidden],[inert]")) trigger.focus({ preventScroll: true });
    });
  }
  function openPresale(id: string) {
    presaleTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    store.focus(id);
    if (mobile) store.selectMobile(id);
    if (snapshot.presentation === "focus") {
      setPresaleRequest(null);
      if (mobile) setDataCollapsed(true);
    } else {
      setPresaleRequest(id);
      setDataCollapsed(false);
    }
  }
  return { presaleId, activePresaleId: documentVisible ? presaleId : null, presaleTarget, setPresaleTarget, setPresaleRequest, openPresale, closePresale };
}

/** Measure the compare grid and select the panels that own live reads at this viewport. */
function usePanelPages(snapshot: WorkspaceV1, mobile: boolean, viewport: string) {
  const [width, height] = viewport.split(":").map(Number) as [number, number];
  const covered = mobile && !snapshot.data.collapsed;
  const [workspaceElement, setWorkspaceElement] = useState<HTMLDivElement | null>(null);
  const [workspaceSize, setWorkspaceSize] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    if (!workspaceElement || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWorkspaceSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(workspaceElement);
    return () => observer.disconnect();
  }, [workspaceElement]);
  const pageSize = workspaceSize ? compareAvailablePageSize(workspaceSize.width, workspaceSize.height) : comparePageSize(width, height, !snapshot.data.collapsed);
  const page = comparePage(snapshot.visible_order, snapshot.focused_panel_id, pageSize);
  const paged = !mobile && snapshot.presentation === "compare" && snapshot.visible_order.length > pageSize;
  let rendered = paged ? page.ids : snapshot.visible_order;
  if (covered) {
    rendered = [];
  } else if (snapshot.presentation === "focus") {
    const selected = mobile ? snapshot.mobile_panel_id : snapshot.focused_panel_id;
    rendered = snapshot.visible_order.filter(id => id === selected);
  } else if (mobile) {
    // All cards mount in the swipe feed, but only the selected one owns live reads.
    const selected = snapshot.mobile_panel_id ?? snapshot.visible_order[0];
    rendered = snapshot.visible_order.filter(id => id === selected);
  }
  return { covered, page, pageSize, paged, rendered, setWorkspaceElement };
}

function useWorkspaceContent({
  store,
  owner,
  entryGeneration,
  slots,
}: Readonly<{
  store: WorkspaceStore;
  owner: WorkspaceOwner;
  entryGeneration: number;
  slots?: WorkspaceSlots;
}>) {
  const savedSnapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const [discoveryPreview] = useState(() => createDiscoveryPreview(discoveryPreviewKey(owner)));
  const [mobilePickerActivated, setMobilePickerActivated] = useState(false);
  const [chosen, setChosen] = useState(discoverChosen);
  function chooseDiscover() {
    if (chosen) return;
    setChosen(true);
    writeBrowserStorage("local", DISCOVER_CHOSEN_KEY, "1");
  }
  function setDataCollapsed(collapsed: boolean) {
    if (mobile) setMobilePickerActivated(true);
    else if (!collapsed) chooseDiscover();
    if (store.getSnapshot().data.collapsed !== collapsed) {
      if (!collapsed) discoveryPreview.clear();
      store.setDataCollapsed(collapsed);
    }
  }
  const documentVisible = useSyncExternalStore(
    subscribeVisibility,
    visible,
    serverFalse,
  );
  const mobile = useSyncExternalStore(
    subscribeMobile,
    mobileScreen,
    serverFalse,
  );
  // Audit BM-05: crossing into the phone layout never opens Discover as a sheet by itself (it would cover
  // an open dialog such as Trade settings); only a tap on the phone does.
  const [pickerScreen, setPickerScreen] = useState(mobile);
  if (pickerScreen !== mobile) {
    setPickerScreen(mobile);
    if (mobile) setMobilePickerActivated(false);
  }
  const viewport = useSyncExternalStore(subscribeViewport, viewportSize, serverViewport);
  const laptop = discoverDefaultCollapsed(Number.parseInt(viewport, 10));
  const snapshot = useMemo(() => {
    const shown = offeredData(savedSnapshot);
    if (shown.presentation !== "focus" || shown.data.collapsed) return shown;
    if (mobile) return { ...shown, data: { ...shown.data, collapsed: !mobilePickerActivated } };
    return laptop && !chosen ? { ...shown, data: { ...shown.data, collapsed: true } } : shown;
  }, [savedSnapshot, mobilePickerActivated, mobile, chosen, laptop]);
  const { presaleId, activePresaleId, presaleTarget, setPresaleTarget, setPresaleRequest, openPresale, closePresale } = usePresalePresentation(snapshot, store, mobile, documentVisible, setDataCollapsed);
  const { covered, page, pageSize, paged, rendered, setWorkspaceElement } = usePanelPages(snapshot, mobile, viewport);
  const [removed, setRemoved] = useState<{ panel: PanelSetup; slot: number } | null>(null);
  const dataCollapseTrigger = useRef<HTMLButtonElement>(null);
  const dataExpandTrigger = useRef<HTMLButtonElement>(null);
  // The column's own CSS transition carries the motion, the same for every path that opens or collapses Discover.
  function toggleData(collapsed: boolean) {
    if (collapsed) {setPresaleRequest(null); targetSlot.current = null; setPick(null);}
    const source = collapsed
      ? dataCollapseTrigger.current
      : dataExpandTrigger.current;
    const focused = document.activeElement === source;
    // A desktop toggle is a choice; the phones' Discover sheet opening and closing is not.
    if (!mobile) chooseDiscover();
    setDataCollapsed(collapsed);
    if (focused)
      window.requestAnimationFrame(() => {
        (collapsed
          ? dataExpandTrigger.current
          : dataCollapseTrigger.current
        )?.focus({ preventScroll: true });
      });
  }

  const focusRequest = useRef<string | null>(null);
  const vacancyFocus = useRef<number | null>(null);
  const targetSlot = useRef<number | null>(null);
  // A pick (Change coin or Add chart) is open until a coin is placed or it is cancelled; slot is null when no slot is free.
  const [pick, setPick] = useState<{ slot: number | null } | null>(null);
  const addingSlot = pick?.slot ?? null;
  const [replacement, setReplacement] = useState<{id:string} | null>(null);
  const replacementTrigger = useRef<HTMLElement | null>(null);
  const replacementFocus = useRef<string | null>(null);
  const staged = useRef<{id:string;store:WorkspaceStore;history:boolean;trade:boolean}|null>(null);
  const firstReplacement = useRef<HTMLButtonElement>(null);
  const dragging = useRef<string | null>(null);
  const panels = useRef<HTMLDivElement>(null);
  const selectedPanel = responsiveSelectedPanel(snapshot,mobile);
  const pendingTradeFocus = useRef<string | null>(null);
  const pickerFocus = useRef<string | null>(null);
  function restorePickerFocus() {
    const id = pickerFocus.current;
    pickerFocus.current = null;
    if (!id) return;
    const panel = panels.current?.querySelector<HTMLElement>(`[data-panel-id="${CSS.escape(id)}"]`);
    const amount = pendingTradeFocus.current === id ? panel?.querySelector<HTMLElement>('[data-panel-amount],input[aria-label="Trade amount in USD"]') : null;
    (amount ?? panel)?.focus({ preventScroll: true });
    if (amount && document.activeElement === amount) pendingTradeFocus.current = null;
  }
  function requestTradeFocus(id:string,trade:boolean) { if(trade) { focusRequest.current = id; pendingTradeFocus.current = id; } }
  const pickerReturn = useRef<{ element: HTMLElement | null; collapsed: boolean } | null>(null);
  function cancelReplacement() {
    staged.current = null;
    setReplacement(null);
    targetSlot.current = null;
    setPick(null);
  }
  function addPanel(input: PanelInput, side?: "buy" | "sell") {
    const current = store.getSnapshot();
    const existing = Object.values(current.panels).find(panel => panel.chain === input.chain && panel.network === input.network && panel.coin_type === normalizeStructTag(input.coin_type));
    const target = panelTarget(current, targetSlot.current);
    const full = !existing?.panel_id || !current.visible_order.includes(existing.panel_id);
    const placement = full && target < 0 ? null : target >= 0 ? target : undefined;
    // Unconfirmed candidates and synchronous caller patches never touch durable setup.
    const destination = placement === null ? createWorkspaceStore(current) : store;
    const id = placePanel(destination, input, placement, side);
    targetSlot.current = null;
    setPick(null);
    if (placement === null) {
      replacementTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      staged.current = {id,store:destination,history:presaleHistory(store).has(id),trade:!!side};
      setReplacement({id});
    } else {
      focusRequest.current = id;
      if (current.presentation === "focus" && mobile && !snapshot.data.collapsed) pickerFocus.current = id;
      requestTradeFocus(id,!!side);
      if (mobile || (current.presentation !== "focus" && pickerReturn.current?.collapsed)) setDataCollapsed(true);
      pickerReturn.current = null;
    }
    return id;
  }
  function cancelAdd() {
    targetSlot.current = null;
    setPick(null);
    const previous = pickerReturn.current;
    pickerReturn.current = null;
    if (previous) {
      setDataCollapsed(previous.collapsed || mobile);
      window.requestAnimationFrame(() => previous.element?.isConnected && previous.element.focus({preventScroll:true}));
    }
  }
  function beginAdd(index: number) {
    pickerReturn.current = {element: document.activeElement instanceof HTMLElement ? document.activeElement : null, collapsed: snapshot.data.collapsed};
    setPresaleRequest(null);
    targetSlot.current = index < 0 ? null : index;
    setPick({ slot: index < 0 ? null : index });
    store.setDataViewEnabled("Coins", true);
    store.selectDataView("Coins");
    setDataCollapsed(false);
    window.requestAnimationFrame(() => (document.querySelector<HTMLElement>('#workspace-data input[type="search"]') ?? document.querySelector<HTMLElement>('#workspace-data [role="tab"][aria-selected="true"]'))?.focus());
  }
  const dispatch: WorkspaceStore = {
    ...store,
    setDataCollapsed,
    add(input) { return addPanel(input); },
    openOnBuy(input) { return addPanel(input, "buy"); },
    openOnSell(input) { return addPanel(input, "sell"); },
    patchPanel(id,patch) {
      const candidate=staged.current;
      const privateCandidate = candidate?.id === id ? candidate : null;
      (privateCandidate?.store ?? store).patchPanel(id,patch);
      if (patch.active_namespace) {
        const history = patch.active_namespace === "presale";
        if (privateCandidate) privateCandidate.history = history;
        else if (history) presaleHistory(store).add(id);
        else presaleHistory(store).delete(id);
      }
    },
    setCapacity(capacity) {
      cancelReplacement();
      store.setCapacity(capacity);
    },
    remove(id) {
      const activePanel = document.activeElement?.closest("[data-panel-id]");
      const slot = store.getSnapshot().desktop_slots!.indexOf(id);
      if (activePanel?.getAttribute("data-panel-id") === id && slot >= 0) vacancyFocus.current = slot;
      const panel = store.getSnapshot().panels[id];
      if (panel) setRemoved({ panel, slot });
      presaleHistory(store).delete(id);
      store.remove(id);
      if (mobile && vacancyFocus.current !== null) setDataCollapsed(false);
    },
  };
  useLayoutEffect(() => {
    if (vacancyFocus.current !== null) {
      const slot = vacancyFocus.current;
      vacancyFocus.current = null;
      (panels.current?.querySelector<HTMLElement>(`[data-vacancy="${slot}"] button`) ?? document.querySelector<HTMLElement>("[data-add-chart]"))?.focus({preventScroll:true});
    }
    const requestedId = focusRequest.current ?? pendingTradeFocus.current;
    if (!requestedId) return;
    const panel = Array.from(panels.current?.children ?? []).find(element => element.getAttribute("data-panel-id") === requestedId);
    if (!(panel instanceof HTMLElement)) return;
    if (focusRequest.current) {
      panel.focus({preventScroll:true});
      if (snapshot.presentation === "focus") panel.closest<HTMLElement>("[data-workspace-scroll]")?.scrollTo({ top: 0, behavior: "instant" });
      else panel.scrollIntoView?.({block:"nearest",inline:"nearest",behavior:"instant"});
      focusRequest.current = null;
    }
    if (pendingTradeFocus.current !== requestedId) return;
    const focusAmount = () => {
      const input = panel.querySelector<HTMLInputElement>('[data-panel-amount],input[aria-label="Trade amount in USD"]');
      if (!input) return;
      if (document.activeElement !== panel) return;
      input.focus({preventScroll:true});
      if (document.activeElement !== input) return;
      pendingTradeFocus.current = null;
      observer.disconnect();
    };
    const observer = new MutationObserver(focusAmount);
    observer.observe(panel, {childList:true,subtree:true});
    focusAmount();
    return () => observer.disconnect();
  }, [snapshot]);
  const value: WorkspaceContextValue = {
    snapshot,
    dispatch,
    owner,
    entry_generation: entryGeneration,
    presale_history: presaleHistory(store),
    selectAsset: id => beginAdd(snapshot.desktop_slots!.indexOf(id)),
    presentation: {
      mode_open: true,
      document_visible: documentVisible,
      visible_panel_ids: rendered,
      paged_panel_ids: paged ? page.ids : undefined,
      selected_mobile_id: snapshot.mobile_panel_id,
      mobile,
      data_covers_mobile_panel: covered,
    },
  };
  function selectPanel(id:string) {
    store.focus(id);
    if(mobile)store.selectMobile(id);
  }
  function openTrade(id:string) {
    selectPanel(id);
    focusRequest.current = id;
  }
  function restoreReplacementFocus() {
        const id = replacementFocus.current;
        replacementFocus.current = null;
        const panel = id ? Array.from(panels.current?.children ?? []).find(element => element.getAttribute("data-panel-id") === id) : null;
        const original=replacementTrigger.current;
        const usable=original?.isConnected && !original.closest('[inert],[hidden],[aria-hidden="true"]');
        const fallback=document.querySelector<HTMLElement>('[data-more-panels-trigger]');
        const tradeInput = id && pendingTradeFocus.current === id && panel instanceof HTMLElement ? panel.querySelector<HTMLInputElement>('[data-panel-amount]') : null;
        (tradeInput ?? (panel instanceof HTMLElement ? panel : usable ? original : fallback))?.focus({preventScroll:true});
        if (tradeInput && document.activeElement === tradeInput) pendingTradeFocus.current = null;
  }
  function confirmReplacement(index: number) {
            const candidate=staged.current;
            if (!replacement || !candidate || candidate.id !== replacement.id) return cancelReplacement();
            if (index >= store.getSnapshot().desktop_capacity) return cancelReplacement();
            const history=presaleHistory(store);
            const previous=history.has(candidate.id);
            if(candidate.history) history.add(candidate.id); else history.delete(candidate.id);
            try {
              store.placePanel(candidate.store.getSnapshot().panels[replacement.id]!,index);
            } catch(error) {
              if(previous) history.add(candidate.id); else history.delete(candidate.id);
              throw error;
            }
            requestTradeFocus(replacement.id, candidate.trade);
            replacementFocus.current = replacement.id;
            staged.current = null;
            setReplacement(null);
            if (mobile) setDataCollapsed(true);
  }
  const replacementChoices = snapshot.desktop_slots!.map((id, index) => ({ id, index, key: `chart-slot-${index}` }));
  const toolbarTarget = useContext(WorkspaceToolbarTarget);
  const toolbar = <WorkspaceToolbar onAddChart={()=>beginAdd(store.getSnapshot().desktop_slots!.indexOf(null))} />;
  const Panel = slots?.panel;
  const Data = snapshot.data.selected_view
    ? slots?.data?.[snapshot.data.selected_view]
    : undefined;
  return {
    page,
    paged,
    pageSize,
    setWorkspaceElement,
    removed,
    undoRemove: () => { if (removed) { store.restorePanel(removed.panel, removed.slot); setRemoved(null); } },
    dismissUndo: () => setRemoved(null),
    value,
    presaleTarget,
    activePresaleId,
    openPresale,
    closePresale,
    selectedPanel,
    selectPanel,
    openTrade,
    toolbarTarget,
    toolbar,
    snapshot,
    presaleId,
    beginAdd,
    dispatch,
    mobile,
    panels,
    covered,
    dragging,
    Panel,
    toggleData,
    dataExpandTrigger,
    setPresaleTarget,
    cancelAdd,
    dataCollapseTrigger,
    addingSlot,
    picking: pick !== null,
    Data,
    documentVisible,
    replacement,
    firstReplacement,
    cancelReplacement,
    restoreReplacementFocus,
    restorePickerFocus,
    confirmReplacement,
    replacementChoices,
    discoveryPreview,
  };
}

function WorkspaceContent(props: Parameters<typeof useWorkspaceContent>[0]) {
  const { slots, store } = props;
  const Discovery = slots?.discovery;
  const workspace = useWorkspaceContent(props);
  useLayoutEffect(() => { rememberWorkspacePreview(workspace.snapshot); }, [workspace.snapshot]);
  const [identities] = useState(createPanelIdentities);
  usePhoneFeed(workspace.panels, store, workspace.mobile && workspace.snapshot.presentation !== "focus", workspace.covered, workspace.snapshot.visible_order, workspace.snapshot.mobile_panel_id ?? workspace.snapshot.visible_order[0] ?? null);
  const {
    value,
    presaleTarget,
    activePresaleId,
    openPresale,
    closePresale,
    selectedPanel,
    selectPanel,
    openTrade,
    toolbarTarget,
    toolbar,
    snapshot,
    presaleId,
    beginAdd,
    mobile,
    setWorkspaceElement,
  } = workspace;
  return (
    <WorkspaceLayoutProvider saved={workspace.snapshot.layout} store={store}>
    <PanelIdentitiesContext value={identities}>
    <DiscoveryPreviewContext value={workspace.discoveryPreview}>
    <WorkspaceContext value={value}>
      <WorkspacePresaleDockContext value={{ target: presaleTarget, activeId: activePresaleId, open: openPresale, close: closePresale }}>
      <WorkspaceTradeDockContext value={{target:null,activeId:selectedPanel?.panel_id ?? null,selectedId:selectedPanel?.panel_id ?? null,select:selectPanel,openTrade}}>
      <div className={styles.content} data-workspace-scroll="" onScroll={event=>{
        const body=event.currentTarget.querySelector<HTMLElement>("#workspace-data-panel");
        if(event.target === event.currentTarget && body && workspaceScrollOwner(body) === event.currentTarget) body.dispatchEvent(new window.Event("scroll",{bubbles:false}));
      }}>
        {slots?.controls}
        {toolbarTarget ? createPortal(toolbar,toolbarTarget) : toolbar}
        {/* While the activity strip's code loads, the strip and its settings control keep their places. */}
        {Discovery && <Suspense fallback={toolbarTarget ? <>
          {createPortal(<SkeletonBox className={`${styles.pendingTool} ${styles.pendingIcon} ${styles.pendingSettings}`} />, toolbarTarget)}
          <StripSkeleton />
        </> : null}><Discovery /></Suspense>}
        <div
          className={styles.layout}
          data-data-open={String(!snapshot.data.collapsed)}
          data-presale-context={String(!!presaleId)}
          data-presentation={snapshot.presentation}
        >
          <WorkspaceDiscovery workspace={workspace} store={store} />
          <div className={styles.workspaceMain} ref={setWorkspaceElement}>
            <ComparePagination workspace={workspace} />
            <WorkspaceEmpty count={snapshot.visible_order.length} saved={snapshot.retained_order.length} onAdd={() => beginAdd(0)} />

          <WorkspacePanels workspace={workspace} />
          </div>

        </div>
        {mobile && snapshot.presentation !== "focus" && <PhoneNav workspace={workspace} store={store} />}
        {workspace.removed && <WorkspaceUndo key={workspace.removed.panel.panel_id} className={styles.undo} label="Asset removed" undo={workspace.undoRemove} dismiss={workspace.dismissUndo} />}
      </div>
      <PanelReplacement workspace={workspace} />
      </WorkspaceTradeDockContext>
      </WorkspacePresaleDockContext>
    </WorkspaceContext>
    </DiscoveryPreviewContext>
    </PanelIdentitiesContext>
    </WorkspaceLayoutProvider>
  );
}

type WorkspacePanelsView = Readonly<{
  snapshot: WorkspaceV1;
  mobile: boolean;
  dispatch: WorkspaceStore;
  panels: RefObject<HTMLDivElement | null>;
  covered: boolean;
  dragging: RefObject<string | null>;
  Panel?: ComponentType<Readonly<{ panel: PanelSetup }>>;
  paged: boolean;
  page: Readonly<{ ids: readonly string[] }>;
}>;
type PanelReplacementView = Readonly<{
  snapshot: WorkspaceV1;
  replacement: Readonly<{ id: string }> | null;
  firstReplacement: RefObject<HTMLButtonElement | null>;
  cancelReplacement: () => void;
  restoreReplacementFocus: () => void;
  confirmReplacement: (index: number) => void;
  replacementChoices: readonly Readonly<{ id: string | null; index: number; key: string }>[];
}>;
type WorkspaceDataView = Readonly<{
  snapshot: WorkspaceV1;
  Data?: ComponentType;
  documentVisible: boolean;
}>;
type WorkspaceBrowserHeaderView = Readonly<{
  snapshot: WorkspaceV1;
  mobile: boolean;
  cancelAdd: () => void;
  toggleData: (collapsed: boolean) => void;
  dataCollapseTrigger: RefObject<HTMLButtonElement | null>;
  covered: boolean;
}>;
type WorkspaceAssetBrowserView = WorkspaceBrowserHeaderView & WorkspaceDataView & Readonly<{
  presaleId: string | null;
  closePresale: () => void;
  setPresaleTarget: (element: HTMLDivElement | null) => void;
  addingSlot: number | null;
  picking: boolean;
  dataExpandTrigger: RefObject<HTMLButtonElement | null>;
}>;
type WorkspaceDiscoveryView = WorkspaceAssetBrowserView & Readonly<{
  restorePickerFocus: () => void;
}>;
type PhoneNavView = Readonly<{
  snapshot: WorkspaceV1;
  toggleData: (collapsed: boolean) => void;
  cancelAdd: () => void;
}>;
type ComparePaginationView = Readonly<{
  paged: boolean;
  page: Readonly<{ start: number; ids: readonly string[] }>;
  pageSize: number;
  snapshot: WorkspaceV1;
  selectPanel: (id: string) => void;
}>;

function WorkspacePanels({ workspace }: Readonly<{ workspace: WorkspacePanelsView }>) {
  const { snapshot, mobile, dispatch, panels, covered, dragging, Panel } = workspace;
  return (
          <PanelSortProvider order={snapshot.visible_order} dispatch={dispatch} disabled={mobile || workspace.paged || snapshot.presentation === "focus"}>
          <div
            aria-label="Asset panels"
            data-phone-feed={mobile && snapshot.presentation !== "focus" ? "" : undefined}
            data-presentation={snapshot.presentation}
            ref={panels}
            tabIndex={-1}
            className={styles.panels}
            data-capacity={snapshot.desktop_capacity}
            data-workspace-panels=""
            data-count={workspace.paged ? workspace.page.ids.length : snapshot.visible_order.length}
            data-covered={String(covered && snapshot.visible_order.length > 0)}
          >
            {snapshot.desktop_slots!.map(id => {
              if (!id) return null;
              return (
                <TrackedPanel dispatch={dispatch} getDraggedPanel={() => dragging.current} onDragChange={id => {dragging.current = id;}} key={id} panel={snapshot.panels[id]!}>
                  {Panel ? <Suspense fallback={<PanelSkeleton focus={snapshot.presentation === "focus"} />}><Panel panel={snapshot.panels[id]!} /></Suspense> : <p>Asset panel</p>}
                </TrackedPanel>
              );
            })}
          </div>
          </PanelSortProvider>
  );
}

function PanelReplacement({ workspace }: Readonly<{ workspace: PanelReplacementView }>) {
  const { snapshot, replacement, firstReplacement, cancelReplacement, restoreReplacementFocus, confirmReplacement, replacementChoices } = workspace;
  return (
      <Sheet className={styles.tradeSheet} open={replacement !== null} labelledBy="workspace-replace-title" initialFocus={() => firstReplacement.current} onRequestClose={cancelReplacement} onClosed={restoreReplacementFocus}>
        <SheetClose onClick={cancelReplacement} />
        <SheetHeading id="workspace-replace-title" title="Replace which chart?" />
        <div className={styles.replacementChoices}>
          {replacementChoices.map(({id,index,key}) => <Button variant="secondary" size="sm" aria-label={`Chart ${index + 1} · ${id ? `${coinTypeIdentity(snapshot.panels[id]!.coin_type).symbol} · ${snapshot.panels[id]!.coin_type} · ${snapshot.panels[id]!.network}` : "Empty"}`} key={key} ref={index===0 ? firstReplacement : undefined}  type="button" onClick={() => confirmReplacement(index)}>Chart {index + 1} · {id ? <AssetChoice panel={snapshot.panels[id]!} /> : "Empty"}</Button>)}
          <Button variant="secondary" size="sm"  type="button" onClick={cancelReplacement}>Cancel</Button>
        </div>
      </Sheet>
  );
}

/**
 * Phone: the cards form one vertical swipe feed. The card that settles in view
 * becomes the selected card (it alone owns live reads); choosing a card
 * elsewhere, such as its coin chip, scrolls the feed to it.
 */
function usePhoneFeed(
  container: RefObject<HTMLDivElement | null>,
  store: WorkspaceStore,
  mobile: boolean,
  covered: boolean,
  order: readonly string[],
  selected: string | null,
) {
  const settled = useRef<string | null>(null);
  const orderKey = order.join("\u0000");
  useEffect(() => {
    const viewport = container.current;
    if (!mobile || covered || !viewport || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => {
      const card = entries.filter(entry => entry.isIntersecting && entry.intersectionRatio >= 0.6).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      const id = card?.target.getAttribute("data-panel-id");
      if (!id || id === store.getSnapshot().mobile_panel_id) return;
      settled.current = id;
      store.selectMobile(id);
      store.focus(id);
    }, { root: viewport, threshold: [0.6, 0.9] });
    for (const card of viewport.querySelectorAll("[data-panel-id]")) observer.observe(card);
    return () => observer.disconnect();
  }, [container, store, mobile, covered, orderKey]);
  useLayoutEffect(() => {
    const viewport = container.current;
    if (!mobile || covered || !viewport || !selected) return;
    if (settled.current === selected) return;
    settled.current = selected;
    const card = [...viewport.querySelectorAll<HTMLElement>("[data-panel-id]")].find(element => element.getAttribute("data-panel-id") === selected);
    if (!card) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    viewport.scrollTo?.({ top: card.offsetTop - viewport.offsetTop, behavior: reduce ? "instant" : "smooth" });
  }, [container, mobile, covered, orderKey, selected]);
}

function WorkspaceDiscovery({ workspace, store }: Readonly<{
  workspace: WorkspaceDiscoveryView;
  store: WorkspaceStore;
}>) {
  const { snapshot, mobile, toggleData, dataExpandTrigger } = workspace;
  return <>
          {snapshot.data.collapsed && !mobile && (
            <div className={styles.dataEdge}>
              <IconButton variant="ghost" size="sm"
                className={styles.discoverButton}
                aria-label="Expand discovery"
                title="Expand discovery"
                aria-controls="workspace-data"
                aria-expanded={false}
                type="button"
                onClick={() => toggleData(false)}
                ref={dataExpandTrigger}
              >
                {snapshot.presentation === "focus" ? <PanelLeftIcon /> : <PanelRightIcon />}
                <span className="sr">Discover coins</span>
              </IconButton>
              <CollapsedDiscoveryIcons />
            </div>
          )}
          {snapshot.presentation === "focus" && mobile ? <Sheet open={!snapshot.data.collapsed} labelledBy="workspace-picker-title" className={styles.marketPicker}
            onRequestClose={() => { workspace.cancelAdd(); toggleData(true); }} onClosed={workspace.restorePickerFocus}>
            <WorkspaceAssetBrowser workspace={workspace} store={store} />
          </Sheet> : <WorkspaceAssetBrowser workspace={workspace} store={store} />}
  </>;
}

function WorkspaceAssetBrowser({ workspace, store }: Readonly<{
  workspace: WorkspaceAssetBrowserView;
  store: WorkspaceStore;
}>) {
  const { snapshot, presaleId, closePresale, mobile, setPresaleTarget, cancelAdd, toggleData, addingSlot, picking } = workspace;
  const section = useRef<HTMLElement>(null);
  // A collapsing Discover slides out at its open width, floating over the board: the grid has already given its column back.
  useLayoutEffect(() => {
    const node = section.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { if (!node.hidden) node.style.setProperty("--discover-width", `${node.offsetWidth}px`); });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
          <section
            ref={section}
            aria-label="Asset browser"
            className={styles.data}
            data-collapsed={String(snapshot.data.collapsed)}
            hidden={snapshot.data.collapsed}
            id="workspace-data"
            data-context={String(!!presaleId)}
            onKeyDown={event => {
              if (event.key !== "Escape" || event.defaultPrevented) return;
              const escape = escapeInDiscover(event.nativeEvent);
              if (escape === "keep") return;
              if (escape === "cleared") { event.preventDefault(); event.stopPropagation(); return; }
              // Picking a coin for a chart: Escape is the notice's Cancel, so focus returns to the control that started the pick.
              if (picking && !presaleId) { event.preventDefault(); event.stopPropagation(); cancelAdd(); return; }
              if (presaleId || mobile || snapshot.presentation === "focus") {
                event.preventDefault(); event.stopPropagation();
                if (presaleId) closePresale(); else { toggleData(true); requestAnimationFrame(() => workspace.dataExpandTrigger.current?.focus()); }
              }
            }}
          >
            <PresaleContextHeader active={presaleId !== null} mobile={mobile} onClose={closePresale} />
            <div className={styles.presaleTarget} ref={setPresaleTarget} hidden={!presaleId} />
            <div className={styles.dataContents} hidden={!!presaleId}>
            <WorkspaceBrowserHeader workspace={workspace} store={store} />
            {!snapshot.data.collapsed && (
              <>
                {addingSlot !== null && <div className={styles.addingNotice} role="status">Choose an asset for chart {addingSlot + 1}. <Button variant="secondary" size="sm"  type="button" onClick={cancelAdd}>Cancel</Button></div>}
                <WorkspaceDataBody
                  key={snapshot.data.selected_view ?? "hidden"}
                  view={snapshot.data.selected_view}
                >
                  <WorkspaceDataSelection workspace={workspace} />
                </WorkspaceDataBody>
              </>
            )}
            </div>
          </section>
  );
}

function WorkspaceBrowserHeader({ workspace, store }: Readonly<{
  workspace: WorkspaceBrowserHeaderView;
  store: WorkspaceStore;
}>) {
  const { snapshot, mobile, cancelAdd, toggleData, dataCollapseTrigger, covered } = workspace;
  const picker = mobile && snapshot.presentation === "focus";
  return (
            <header className={styles.dataHeader}>
              <div className={styles.dataTitleRow}>
                <h2 id={picker ? "workspace-picker-title" : undefined}>Discover</h2>
                {snapshot.data.enabled_views.length > 0 && <MoreDataViews views={snapshot.data.enabled_views} selected={snapshot.data.selected_view} onSelect={view => store.selectDataView(view)} />}
              <div className={styles.dataActions}>
                <IconButton variant="ghost" size="sm"
                  data-workspace-escape={mobile && !snapshot.data.collapsed ? "data" : undefined}
                  aria-label={mobile ? "Close Discover" : snapshot.presentation === "focus" ? "Collapse discovery" : "Close asset browser"}
                  title={mobile ? "Close Discover" : "Close asset browser"}
                  aria-controls="workspace-data"
                  aria-expanded={true}
                  type="button"
                  onClick={() => { cancelAdd(); toggleData(true); }}
                  ref={dataCollapseTrigger}
                >
                  {/* The phone sheet dismisses, so it shows a close glyph; the desktop sidebar collapses. */}
                  {mobile ? <CloseIcon /> : snapshot.presentation === "focus" ? <PanelLeftIcon /> : <PanelRightIcon />}
                </IconButton>
              </div>
              </div>
              {snapshot.data.enabled_views.length > 0 && <DataViewTabs views={snapshot.data.enabled_views} selected={snapshot.data.selected_view ?? snapshot.data.enabled_views[0]!} onSelect={view => store.selectDataView(view)} />}
              {covered && snapshot.visible_order.length > 0 && (
                <span className={styles.coverage}>Covering asset panel</span>
              )}
            </header>
  );
}

function WorkspaceDataSelection({ workspace }: Readonly<{ workspace: WorkspaceDataView }>) {
  const { snapshot, Data, documentVisible } = workspace;
  return (
Data && documentVisible ? (
                    <Suspense
                      fallback={
                        <RowsSkeleton
                          label={`Opening ${snapshot.data.selected_view} Data`}
                        />
                      }
                    >
                      <Data />
                    </Suspense>
                  ) : (
                    <p>Find an asset to add to your workspace.</p>
                  )
  );
}

/** With saved panels behind the dock's Saved control, the board is not empty of panels, only of an active one (audit inventory). */
function WorkspaceEmpty({ count, saved, onAdd }: Readonly<{ count: number; saved: number; onAdd: () => void }>) {
  if (count > 0) return null;
  return <div className={styles.empty}><h1>{saved > 0 ? "No active panel" : "No panels"}</h1>{saved > 0 ? <p>Open one from Saved or add a coin.</p> : null}<Button variant="primary" size="sm"  type="button" onClick={onAdd}><PlusIcon /> Add panel</Button></div>;
}

function PresaleContextHeader({ active, mobile, onClose }: Readonly<{ active: boolean; mobile: boolean; onClose: () => void }>) {
  if (!active) return null;
  return <header className={styles.dataHeader}><h3>Presale</h3><Button variant="secondary" size="sm" data-workspace-escape="presale"  type="button" onClick={onClose}>Back to {mobile ? "panels" : "data"}</Button></header>;
}

function responsiveSelectedPanel(snapshot:WorkspaceV1,mobile:boolean) {
  const id=mobile ? snapshot.mobile_panel_id : snapshot.focused_panel_id;
  return id && snapshot.visible_order.includes(id) ? snapshot.panels[id] : snapshot.panels[snapshot.visible_order[0] ?? ""];
}

/**
 * The header bar (BlastMode.dc.html): the current coin and Saved, search, then
 * Portfolio, the balance, Layout and settings at the end. Persisting is quiet: the
 * save status keeps a fixed slot for a slow save or a failure (audit 03).
 */
function WorkspaceToolbar({
  onAddChart,
}: Readonly<{
  onAddChart: () => void;
}>) {
  const { snapshot, dispatch: store, presentation } = useWorkspace();
  const statusSlot = useContext(WorkspaceStatusSlot);
  const mobile = presentation.mobile;
  return (
    <div className={styles.toolbar}>
      <div className={styles.panelTools}>
        <PanelDock snapshot={snapshot} dispatch={store} mobile={mobile} />
      </div>
      <WorkspaceSearch open={!snapshot.data.collapsed} onSearch={snapshot.presentation === "focus" ? () => openWorkspaceSearch(store) : onAddChart} />
      <span className={styles.toolbarSpacer} />
      <span className={styles.saveStatus} data-workspace-save-status="" ref={statusSlot} />
      <WorkspacePortfolio />
      <WorkspaceBalance />
      <WorkspaceLayoutTools className={styles.workspaceTools} disabled={!snapshot.focused_panel_id} trigger={WorkspaceShortcuts} />
    </div>
  );
}

/** The signed-in viewer's portfolio value from the shell's read, with its breakdown; nothing for a guest. */
function WorkspaceBalance() {
  const signedIn = !!useCurrentBlastAccount().accountState?.account;
  const portfolio = useShellPortfolioContext();
  const hidden = useShellPrefs().amountsHidden;
  const testPricing = useTestPricing();
  return <>
    {/* The page's test-pricing notice sits under Blast mode; its compact form keeps the context beside the balance, for guests' prices too (audit 31). */}
    <TestPricingNotice compact enabled={testPricing} />
    {signedIn ? <span className={styles.balance}><AccountBalance hidden={hidden} portfolio={portfolio.state} onRetry={portfolio.refresh} /></span> : null}
  </>;
}

function dataViewTabId(view: DataView) {
  return `workspace-data-tab-${view}`;
}

/**
 * Coins · Presales · Bonding · Posts as the shared segmented tablist (neutral thumb);
 * the other enabled views sit in More, beside the title, which shows the one open (the track never grows a fifth tab).
 * Arrows, Home and End move between tabs.
 */
function DataViewTabs({ views, selected, onSelect }: Readonly<{ views: readonly DataView[]; selected: DataView; onSelect: (view: DataView) => void }>) {
  const tabs = views.filter(view => PRIMARY_DATA_VIEWS.includes(view));
  return (
    <Segmented
      tabs
      stretch
      size="sm"
      label="What to discover"
      className={styles.viewTabs}
      options={tabs.map(view => [view, <span key={view}>{dataViewLabel(view)}</span>] as const)}
      value={selected}
      onChange={onSelect}
      tabId={dataViewTabId}
      panelId={() => "workspace-data-panel"}
    />
  );
}

/**
 * The overflow beside the tabs (live audit F33): a menu, not a native select, and its trigger names the open view and
 * wears the selected look, so the open view always shows, whether it is a tab or here.
 */
function MoreDataViews({ views, selected, onSelect }: Readonly<{ views: readonly DataView[]; selected: DataView | null; onSelect: (view: DataView) => void }>) {
  const secondary = views.filter(view => !PRIMARY_DATA_VIEWS.includes(view));
  if (secondary.length === 0) return null;
  const current = selected && secondary.includes(selected) ? selected : null;
  return (
    <BlastMenu
      anchored
      className={styles.moreMenu}
      label="More views"
      placement={() => ({ side: "bottom", align: "end", sideOffset: 6, avoid: "flip", originX: "100%" })}
      trigger={<BlastMenuTrigger render={<DisclosureButton variant="secondary" size="sm" aria-label={`More views: ${current ? dataViewLabel(current) : "none open"}`} data-current={current ? "true" : undefined}>{current ? dataViewLabel(current) : "More"}</DisclosureButton>} className={styles.moreViews} />}
    >
      <BlastMenuRadioGroup value={current ?? ""} onValueChange={value => onSelect(value as DataView)}>
        {secondary.map(view => (
          <BlastMenuRadioItem className={styles.moreItem} closeOnClick key={view} value={view}>
            {dataViewLabel(view)}
            <BlastMenuRadioItemIndicator className={styles.moreCheck}> ✓</BlastMenuRadioItemIndicator>
          </BlastMenuRadioItem>
        ))}
      </BlastMenuRadioGroup>
    </BlastMenu>
  );
}

const PHONE_NAV_PRIORITY: readonly DataView[] = ["Coins", "Presales", "Portfolio", "Activity", "Traders", "Feed", "Bonding"];

/**
 * Discover always offers the full set of views, including views hidden by older saved setups.
 */
function offeredData(snapshot: WorkspaceV1): WorkspaceV1 {
  const enabled_views = [...DATA_VIEWS];
  const selected = snapshot.data.selected_view;
  const selected_view = selected !== null && enabled_views.includes(selected) ? selected : (enabled_views[0] ?? null);
  if (enabled_views.join() === snapshot.data.enabled_views.join() && selected_view === selected) return snapshot;
  return { ...snapshot, data: { ...snapshot.data, enabled_views, selected_view } };
}

/** Phone: Panels plus four enabled Data views, in the thumb's reach. */
function PhoneNav({ workspace, store }: Readonly<{ workspace: PhoneNavView; store: WorkspaceStore }>) {
  const { snapshot, toggleData, cancelAdd } = workspace;
  const selected = snapshot.data.selected_view;
  // Finding and keeping track come first; every view stays reachable from the Data tabs.
  const first = PHONE_NAV_PRIORITY.filter(view => snapshot.data.enabled_views.includes(view)).slice(0, 4);
  // The selected view always keeps its place, so the view Data opens to is reachable.
  const views = selected && !first.includes(selected) ? [...first.slice(0, 3), selected] : first;
  const current = snapshot.data.collapsed ? null : (snapshot.data.selected_view ?? views[0] ?? null);
  return (
    <nav aria-label="Blast mode sections" className={styles.phoneNav} {...dyn({ "--nav-count": views.length + 1 } as CSSProperties)}>
      <Button variant="ghost" size="sm" aria-current={current === null ? "page" : undefined} onClick={() => { cancelAdd(); toggleData(true); }} type="button">
        <GridIcon />
        <span>Panels</span>
      </Button>
      {views.map(view => (
        <Button variant="ghost" size="sm"
          aria-current={current === view ? "page" : undefined}
          key={view}
          onClick={() => {
            store.selectDataView(view);
            if (snapshot.data.collapsed) toggleData(false);
          }}
          type="button"
        >
          <DataViewIcon view={view} />
          <span>{dataViewLabel(view)}</span>
        </Button>
      ))}
    </nav>
  );
}

function WorkspaceDataBody({
  view,
  children,
}: Readonly<{
  view: DataView | null;
  children: ReactNode;
}>) {
  const { snapshot, dispatch } = useWorkspace();
  const body = useRef<HTMLDivElement>(null);
  const [initialScroll] = useState(
    view ? snapshot.data.controls[view].navigation.scroll_top : 0,
  );
  const rememberPortfolio = (element: HTMLElement) => {
    const controls = snapshot.data.controls.Portfolio;
    const top = element.getBoundingClientRect().top;
    const rows = [
      ...element.querySelectorAll<HTMLElement>("[data-workspace-portfolio]"),
    ];
    const index = rows.findIndex(
      (row) => row.getBoundingClientRect().bottom > top,
    );
    const row = rows[index];
    dispatch.patchDataControls("Portfolio", {
      ...controls,
      navigation: {
        ...controls.navigation,
        scroll_top: element.scrollTop,
        anchor: row
          ? {
              row_id: row.dataset.workspacePortfolio!,
              index,
              offset: row.getBoundingClientRect().top - top,
            }
          : controls.navigation.anchor,
      },
    });
  };
  useLayoutEffect(() => {
    // Actor and post lists restore their saved position after result rows mount.
    if (
      body.current &&
      view !== "Traders" &&
      view !== "Feed" &&
      view !== "Activity" &&
      (view !== "Portfolio" ||
        snapshot.data.controls.Portfolio.tab === "summary")
    )
      workspaceScrollOwner(body.current).scrollTop = initialScroll;
  }, [initialScroll, view, snapshot.data.controls.Portfolio.tab]);
  return (
    <div
      // A tab names its own view's panel; a view opened from More is named directly (the More select is not its name).
      aria-labelledby={view && PRIMARY_DATA_VIEWS.includes(view) ? dataViewTabId(view) : undefined}
      aria-label={view === null ? "Hidden Data views" : PRIMARY_DATA_VIEWS.includes(view) ? undefined : dataViewLabel(view)}
      className={styles.dataBody}
      data-scroll-fade=""
      id="workspace-data-panel"
      ref={body}
      role={view === null ? "region" : "tabpanel"}
      tabIndex={0}
      onScroll={(event) => {
        if (!view) return;
        if (view === "Portfolio") {
          rememberPortfolio(workspaceScrollOwner(event.currentTarget));
          return;
        }
        if (view === "Bonding") {
          // Bonding's pages are not saved, so neither is a row: only the position.
          const controls = snapshot.data.controls.Bonding;
          const element = workspaceScrollOwner(event.currentTarget);
          dispatch.patchDataControls("Bonding", { ...controls, navigation: { ...controls.navigation, scroll_top: element.scrollTop } });
          return;
        }
        if (view === "Feed" || view === "Activity") {
          const controls = snapshot.data.controls[view];
          const element = workspaceScrollOwner(event.currentTarget);
          const top = element.getBoundingClientRect().top;
          const selector =
            view === "Feed"
              ? "[data-workspace-post]"
              : "[data-workspace-event]";
          const rows = [...element.querySelectorAll<HTMLElement>(selector)];
          const index = rows.findIndex(
            (row) => row.getBoundingClientRect().bottom > top,
          );
          const row = rows[index];
          dispatch.patchDataControls(view, {
            ...controls,
            navigation: {
              ...controls.navigation,
              scroll_top: element.scrollTop,
              anchor: row
                ? {
                    entry_id: (view === "Feed"
                      ? row.dataset.workspacePost
                      : row.dataset.workspaceEvent)!,
                    index,
                    offset: row.getBoundingClientRect().top - top,
                  }
                : controls.navigation.anchor,
            },
          });
          return;
        }
        if (view === "Traders") {
          const controls = snapshot.data.controls.Traders;
          const element = workspaceScrollOwner(event.currentTarget);
          const top = element.getBoundingClientRect().top;
          const rows = [
            ...element.querySelectorAll<HTMLElement>("[data-workspace-trader]"),
          ];
          const index = rows.findIndex(
            (row) => row.getBoundingClientRect().bottom > top,
          );
          const row = rows[index];
          dispatch.patchDataControls("Traders", {
            ...controls,
            navigation: {
              ...controls.navigation,
              scroll_top: element.scrollTop,
              anchor: row
                ? {
                    actor_key: row.dataset.workspaceTrader!,
                    index,
                    offset: row.getBoundingClientRect().top - top,
                  }
                : controls.navigation.anchor,
            },
          });
          return;
        }
        // The remaining Coins/Presales views share canonical row anchors.
        {
          const controls = snapshot.data.controls[view];
          const element = workspaceScrollOwner(event.currentTarget);
          const top = element.getBoundingClientRect().top;
          const rows = [
            ...element.querySelectorAll<HTMLElement>("[data-workspace-row]"),
          ];
          const index = rows.findIndex(
            (row) => row.getBoundingClientRect().bottom > top,
          );
          const row = rows[index];
          dispatch.patchDataControls(view, {
            ...controls,
            navigation: {
              ...controls.navigation,
              scroll_top: element.scrollTop,
              anchor: row
                ? {
                    coin_type: row.dataset.workspaceRow!,
                    index,
                    offset: row.getBoundingClientRect().top - top,
                  }
                : controls.navigation.anchor,
            },
          });
          return;
        }
      }}
    >
      {children}
    </div>
  );
}

function placePanel(store: WorkspaceStore, input: PanelInput, placement: number | null | undefined, side?: "buy" | "sell") {
  if (side === "sell") return store.openOnSell(input, placement);
  if (side === "buy") return store.openOnBuy(input, placement);
  return store.add(input, placement);
}

function panelTarget(snapshot: WorkspaceV1, requested: number | null) {
  if (requested !== null && requested < snapshot.desktop_capacity) return requested;
  const vacancy = snapshot.desktop_slots!.indexOf(null);
  if (vacancy >= 0 || snapshot.presentation !== "focus") return vacancy;
  return snapshot.desktop_slots!.indexOf(snapshot.focused_panel_id);
}

function ComparePagination({ workspace }: Readonly<{ workspace: ComparePaginationView }>) {
  const { paged, page, pageSize, snapshot, selectPanel } = workspace;
  if (!paged) return null;
  return <nav className={styles.pageNav} aria-label="Compare pages">
    <span>Panels {page.start + 1}–{page.start + page.ids.length} of {snapshot.visible_order.length}</span>
    <span className={styles.pageHint}>More room for charts and trading</span>
    <Button variant="ghost" size="sm" type="button" disabled={page.start === 0} onClick={() => selectPanel(snapshot.visible_order[page.start - pageSize]!)}>Previous</Button>
    <Button variant="ghost" size="sm" type="button" disabled={page.start + pageSize >= snapshot.visible_order.length} onClick={() => selectPanel(snapshot.visible_order[page.start + pageSize]!)}>Next</Button>
  </nav>;
}
