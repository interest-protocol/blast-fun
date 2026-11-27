"use client";

import { AudioMenu } from "./AudioMenu.tsx";
import { isPresaleId } from "@blast/core/modules/presale/presale-id.ts";
import clsx from "clsx";
import { Button, IconButton, IconButtonLink, type ControlSize } from "./Button";
import { usePathname, useRouter } from "next/navigation";
import * as React from "react";
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useNotificationFeedback, type SubscribeNotificationArrivals } from "./notification-feedback";
import type {} from "react/canary";

import { AccountMenu } from "./AccountMenu";
import { ServiceStatus } from "./ServiceStatus";
import { RailLinks } from "./RailLinks";
import styles from "./AppShell.module.css";
import { BlastMenuTrigger, useMenuHandle, type MenuHandle } from "./BlastMenu";
import { CreateMenu } from "./CreateMenu";
import { FeedbackSheet } from "./FeedbackSheet";
import { MoreNavigation } from "./MoreNavigation";
import {
  BellIcon,
  PencilIcon,
  CurveIcon,
  HelmetMark,
  HomeIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PieIcon,
  PlusIcon,
  SearchIcon,
  SwapIcon,
  TicketIcon,
} from "./Icons";
import type { CreateMenuPayload } from "./menu-placement.ts";
import { MissingPageProvider } from "./shell-missing-page";
import { BONDING_PATH, HOME_PATH, INVITES_PATH, isHomePath, PORTFOLIO_PATH, PRESALES_PATH, profilePath, SETTINGS_PATH, shellNavKeyFor, shortcutFor, type ShellActionName, type ShellNavKey } from "./nav";
import { portfolioTabAt } from "#web/components/blast-ui/portfolio-navigation.ts";
import { PrimaryLink as Link } from "./NavigationLink";
import { CoinPageWalletContext } from "./CoinPageWallet";
import { AccountBalance } from "./AccountBalance";
import type { PortfolioSummaryState } from "./portfolio";
import { nextTheme } from "./prefs";
import { ShellActionsProvider, useShellActions } from "./shell-actions";
import type { ShellViewer } from "./shell-viewer";
import { ShellAvatar } from "./ShellAvatar";
import { ShellAvatarRenderer, type RenderAvatar } from "./shell-avatar-renderer.ts";
import { ToastProvider, useToast } from "./Toasts";
import { TooltipGroup } from "./TooltipGroup";
import { applyTheme, setShellPref, useShellPrefs } from "./use-shell-prefs";

/**
 * The canonical UI's app shell (FEATURE-MAP §1; the 2026-10-27 Rail, Topbar
 * and Mobile boards): the left rail (collapsible, remembered per device), the
 * top bar, the page column, the sticky right column (Home's collapses to a
 * 44px button), and on phones the docked tab bar. It hosts the account menu, the toasts and the shell actions that
 * later sections fill (`shell-actions.tsx`). Layout and preferences are pure
 * CSS on the page root's attributes (`prefs.ts`), so the first paint is
 * already right; React only keeps the ARIA state in step.
 */
export type AppShellProps = Readonly<{
  /** The session is signed in (the account below may still be loading). */
  signedIn: boolean;
  /** The signed-in account; null for a visitor or while it loads. */
  viewer: ShellViewer | null;
  renderAvatar?: RenderAvatar;
  /** The session or account is still being read: reserve its controls without offering Sign in. */
  viewerLoading?: boolean;
  viewerError?: boolean;
  onRetryAccount?: () => void;
  onRetryPortfolio?: () => void;
  onSoundToggle?: (enabled: boolean) => void;
  /** Where "Sign in" goes without a sign-in sheet: `/sign-in?next=…`. */
  signInHref: string;
  /** Ends the session; the page stays and reads as a visitor's. */
  onSignOut?: () => Promise<void>;
  portfolio: PortfolioSummaryState;
  /** Unread notifications: the account bar’s bell badge and accessible count. */
  unreadCount?: number;
  subscribeNotificationArrivals?: SubscribeNotificationArrivals;
  /** The notifications page; until it exists the item runs the `openNotifications` action. */
  notificationsHref?: string | null;
  /** Content above the page (empty by default). */
  banner?: ReactNode;
  /** The right column's cards (≥1220px). On Home they sit under "What's happening"; `null` on Home draws no column at all. */
  aside?: ReactNode;
  /** The collapsed column's own content, below its expand button (Home passes none since the coin rows). */
  asideMini?: ReactNode;
  /** Home's column header controls before the collapse button (R3-77: the "Choose cards" menu). */
  asideActions?: ReactNode;
  /** Whether this is Home (its right column has a header and collapses); by default from the path. */
  home?: boolean;
  /** The current rail and tab item; by default from the path. */
  currentItem?: ShellNavKey | null;
  /**
   * Sheets and dialogs that outlive a page (sign-in, onboarding): rendered
   * after the shell, outside the route transition, inside the shell's
   * actions and toasts.
   */
  overlays?: ReactNode;
  children: ReactNode;
}>;

function useHasNavigated(pathname: string | null): boolean {
  const [firstPath] = useState(pathname);
  const [navigated, setNavigated] = useState(false);
  if (!navigated && pathname !== firstPath) setNavigated(true);
  return navigated;
}

const PageTransition = React.ViewTransition ?? React.Fragment;

function pageTransitionName(pathname: string | null, home: boolean) {
  if (home) return "blast-home";
  const asset = pathname?.match(/^\/(coin|presale)\/([^/]+)\/?$/);
  return asset && (asset[1] === "coin" || isPresaleId(asset[2]!)) ? "blast-asset" : "blast-page";
}

/** Peer portfolio sections keep their mounted summary and list controls. */
function pageIdentity(pathname: string | null): string {
  const path = pathname ?? "";
  return portfolioTabAt(path) === null ? path : PORTFOLIO_PATH;
}

/** A page's first surface: the right column's first card lines up with it. */
const SURFACE = "[data-surface], .card, .sbox, .seg";

function isEditable(target: EventTarget | null): target is HTMLElement {
  return target instanceof HTMLElement;
}

/** Whether a modal layer (a later section's sheet) is open; shortcuts then stay quiet. */
function dialogOpen(): boolean {
  return document.querySelector('dialog[open], [aria-modal="true"]') !== null;
}

export function AppShell({ renderAvatar, ...props }: AppShellProps) {
  return (
    <ShellActionsProvider>
      <ToastProvider>
        <ShellAvatarRenderer value={renderAvatar}>
          <TooltipGroup>
            <ShellFrame {...props} />
          </TooltipGroup>
        </ShellAvatarRenderer>
      </ToastProvider>
    </ShellActionsProvider>
  );
}

/** Portfolio and Settings carry their own wallet actions, so the shell shows no balance or Fund there (Topbar board). */
function pageHasWalletActions(pathname: string | null): boolean {
  return /^\/(?:portfolio|settings)(?:\/|$)/.test(pathname ?? "");
}

function pageHidesAside(pathname: string | null, home: boolean, aside: ReactNode): boolean {
  return pathname === "/presale" || pathname === BONDING_PATH || pathname === "/competitions" || pathname?.startsWith("/competitions/") === true || pathname?.startsWith("/vesting") === true || pathname?.startsWith("/coin/") === true || (home && aside === null);
}

function PageAside({ hidden, ...props }: Parameters<typeof ShellAside>[0] & Readonly<{ hidden: boolean }>) {
  if (hidden) return null;
  return <ShellAside {...props} />;
}

function ShellFrame({
  signedIn,
  viewer,
  viewerLoading = false,
  viewerError = false,
  onRetryAccount,
  onRetryPortfolio,
  onSoundToggle,
  signInHref,
  onSignOut,
  portfolio,
  unreadCount = 0,
  subscribeNotificationArrivals,
  notificationsHref = null,
  banner,
  aside,
  asideMini,
  asideActions,
  home: homeOverride,
  currentItem,
  overlays,
  children,
}: AppShellProps) {
  const pathname = usePathname();
  const topbar = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const header = topbar.current;
    if (!header) return;
    const measure = () => header.parentElement?.style.setProperty("--shell-topbar-height", `${header.getBoundingClientRect().height}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);
  const navigated = useHasNavigated(pathname);
  const router = useRouter();
  const prefs = useShellPrefs();
  const run = useShellActions();
  const toast = useToast();
  // Detached menu triggers share their shell handles.
  const accountMenu = useMenuHandle<undefined>();
  const createMenu = useMenuHandle<CreateMenuPayload>();
  const home = homeOverride ?? isHomePath(pathname);
  const transitionName = pageTransitionName(pathname, home);
  const transitionProps = "ViewTransition" in React ? { name: transitionName, default: "blast-route", update: "none" } : {};
  const noAside = pageHidesAside(pathname, home, aside);
  const [missingPage, setMissingPage] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const current = missingPage ? null : currentItem !== undefined ? currentItem : shellNavKeyFor(pathname, viewer?.callsign ?? null);
  const ownProfile = viewer?.callsign ? profilePath(viewer.callsign) : signInHref;

  // Search shortcut: `/`.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = shortcutFor(event, isEditable(event.target) ? event.target : null, dialogOpen());
      if (!action) return;
      event.preventDefault();
      run(action);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [run]);

  const logOut = () => {
    if (!onSignOut) return;
    void onSignOut().catch(() => toast("Sign-out did not finish. You are still signed in. Try again."));
  };

  const runOr = (name: ShellActionName) => () => {
    run(name);
  };

  const signIn = (event: MouseEvent<HTMLAnchorElement>) => {
    if (run("openSignIn")) event.preventDefault();
  };

  const account = signedIn && !viewerLoading ? viewer : null;
  const wallet = { pathname, hidden: prefs.amountsHidden, portfolio, onRetry: onRetryPortfolio, onFund: runOr("openFund") };

  return (
    <>
      <div className={styles.shell} data-account={Boolean(account) || undefined} data-home={home || undefined} data-navigated={navigated || undefined} data-no-aside={noAside || undefined}>
        <nav aria-label="Primary" className={styles.rail} data-shell-rail="">
          <RailHeader mini={prefs.railMini} />
          <RailItem current={current} href={HOME_PATH} icon={<HomeIcon />} item="home" label="Home" />
          <button aria-haspopup="dialog" aria-label="Swap" className={styles.navItem} onClick={runOr("openTrade")} type="button">
            <SwapIcon />
            <span>Swap</span>
          </button>
          <LaunchDestinations current={current} />
          <RailItem current={current} href={PORTFOLIO_PATH} icon={<PieIcon />} item="portfolio" label="Portfolio" />
          <BlastMenuTrigger
            aria-label="Create"
            className={clsx(styles.navItem, styles.railCreate)}
            data-create-action=""
            handle={createMenu}
            payload="rail"
          >
            <PlusIcon />
            <span>Create</span>
          </BlastMenuTrigger>
          <div className={styles.railSpacer} />
          <div className={styles.railFooter}>
            <Button aria-haspopup="dialog" className={styles.navItem} onClick={() => setFeedbackOpen(true)} variant="nav">
              <PencilIcon />
              <span>Send feedback</span>
            </Button>
            <RailLinks />
            <ServiceStatus />
          </div>
        </nav>

        <header className={styles.topbar} data-shell-topbar="" ref={topbar}>
          <Link aria-label="Blast home" className={styles.brand} href={HOME_PATH}>
            <BrandMark />
            <b>blast</b>
          </Link>
          <span className={styles.topbarTools}>
            <ServiceStatus mobile />
            <IconButton aria-keyshortcuts="/" aria-label="Search" className={styles.topbarTool} onClick={runOr("openSearch")} size="chip" title="Search (/)">
              <SearchIcon />
            </IconButton>
            <AudioMenu className={styles.topbarTool} onToggle={onSoundToggle} />
          </span>
          {account ? <ShellWallet {...wallet} size="chip" /> : <AccountMessage error={viewerError} loading={viewerLoading} signedIn={signedIn} />}
          <NotificationsIconLink
            count={unreadCount}
            subscribeArrivals={subscribeNotificationArrivals}
            current={current === "alerts"}
            href={notificationsHref}
            onAction={runOr("openNotifications")}
          />
          <BlastMenuTrigger
            aria-label="Create"
            className={clsx("icon-btn", styles.createAction)}
            data-create-action=""
            handle={createMenu}
            title="Create"
          >
            <PlusIcon />
          </BlastMenuTrigger>
          <TopbarAccount
            handle={accountMenu}
            loading={viewerLoading}
            signedIn={signedIn}
            error={viewerError}
            onRetry={onRetryAccount}
            onSignIn={signIn}
            profileCurrent={current === "profile"}
            signInHref={signInHref}
            viewer={account}
          />
        </header>

        <main className={styles.main} data-shell-column="" id="main">
          {banner}
          <PageTransition {...transitionProps} key={pageIdentity(pathname)}>
            <div className={styles.view} id="view">
              <CoinPageWalletContext value={<ShellWallet {...wallet} available={Boolean(account)} pending={viewerLoading} size="sm" />}>
                <MissingPageProvider onChange={setMissingPage}>{children}</MissingPageProvider>
              </CoinPageWalletContext>
            </div>
          </PageTransition>
        </main>

        <PageAside actions={asideActions} home={home} hidden={noAside} collapsed={prefs.asideCollapsed} mini={asideMini} pathname={pathname}>
          {aside}
        </PageAside>

        <nav aria-label="Tabs" className={styles.tabbar} data-shell-tabbar="">
          <TabItem current={current} href={HOME_PATH} icon={<HomeIcon />} item="home" label="Home" />
          <button aria-haspopup="dialog" aria-label="Swap" className={styles.tabSwap} onClick={runOr("openTrade")} type="button">
            <SwapIcon />
            Swap
          </button>
          <LaunchDestinations current={current} mobile />
          <MoreNavigation createMenu={createMenu} key={pathname} onFeedback={() => setFeedbackOpen(true)} />
        </nav>
      </div>
      <AccountMenu
        handle={accountMenu}
        onCycleTheme={(origin) => applyTheme(nextTheme(prefs.theme), origin)}
        onLogOut={logOut}
        onProfile={() => router.push(ownProfile)}
        onPortfolio={() => router.push(PORTFOLIO_PATH)}
        onSettings={() => router.push(SETTINGS_PATH)}
        onInvites={() => router.push(INVITES_PATH)}
        theme={prefs.theme}
        viewer={account}
      />
      <CreateMenu handle={createMenu} />
      <FeedbackSheet open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
      {overlays}
    </>
  );
}

function LaunchDestinations({ current, mobile = false }: Readonly<{ current: ShellNavKey | null; mobile?: boolean }>) {
  const Item = mobile ? TabItem : RailItem;
  return (
    <>
      <Item current={current} href={BONDING_PATH} icon={<CurveIcon />} item="bonding" label="Bonding" prefetch={false} />
      <Item current={current} href={PRESALES_PATH} icon={<TicketIcon />} item="presales" label="Presales" />
    </>
  );
}

type WalletSize = Extract<ControlSize, "chip" | "sm">;

function ShellWallet({ pathname, hidden, portfolio, onRetry, onFund, size, available = true, pending = false }: Readonly<{
  available?: boolean; pending?: boolean; pathname: string | null; hidden: boolean; portfolio: PortfolioSummaryState; onRetry?: () => void; onFund: () => void; size: WalletSize;
}>) {
  if ((!available && !pending) || pageHasWalletActions(pathname)) return null;
  if (size === "sm" && !pathname?.startsWith("/coin/")) return null;
  const controls = <>
    <AccountBalance hidden={hidden} onRetry={onRetry} portfolio={portfolio} size={size} />
    <FundButton onFund={onFund} size={size} />
  </>;
  return size === "sm" ? <span className={styles.pageWallet} inert={pending || undefined}>{controls}</span> : controls;
}

/** The bar's Fund: neutral like the rest of the chrome, so each page keeps its own one pink action (2026-11-14). */
function FundButton({ onFund, size }: Readonly<{ onFund: () => void; size: WalletSize }>) {
  return (
    <Button className={styles.deposit} onClick={onFund} size={size} variant="secondary">
      Fund
    </Button>
  );
}

/** The brand mark: the Blast helmet, decorative beside the wordmark (owner, 2026-10-29: always the helmet, never the bolt). */
function BrandMark() {
  return <HelmetMark className={styles.mark} />;
}

function AccountMessage({ error, loading, signedIn }: Readonly<{ error: boolean; loading: boolean; signedIn: boolean }>) {
  if (loading) return null;
  return error || signedIn ? <p className={styles.accountMessage} role="status">Your account could not load.</p> : null;
}

function TopbarAccount({ handle, loading, signedIn, error, onRetry, onSignIn, profileCurrent, signInHref, viewer }: Readonly<{
  handle: MenuHandle<undefined>;
  loading: boolean;
  signedIn: boolean;
  error: boolean;
  onRetry?: () => void;
  onSignIn: (event: MouseEvent<HTMLAnchorElement>) => void;
  signInHref: string;
  profileCurrent: boolean;
  viewer: ShellViewer | null;
}>) {
  if (loading) return <div aria-hidden="true" className={styles.accountPlaceholder} />;
  if (!viewer) {
    if (error || signedIn) return <button className={clsx("btn btn-quiet", styles.topbarSignin)} onClick={onRetry} type="button">Try again</button>;
    return (
      <Link className={clsx("btn btn-ink", styles.topbarSignin)} href={signInHref} onClick={onSignIn} prefetch={false}>
        Sign in
      </Link>
    );
  }
  return (
    <BlastMenuTrigger
      aria-label="Account menu"
      className={styles.topbarAvatar}
      data-current={profileCurrent || undefined}
      handle={handle}
      title="Account menu"
    >
      <ShellAvatar size={32} viewer={viewer} />
    </BlastMenuTrigger>
  );
}

function RailHeader({ mini }: Readonly<{ mini: boolean }>) {
  return (
    <div className={styles.railTop}>
      <Link aria-label="Blast home" className={styles.brand} href={HOME_PATH}>
        <BrandMark />
        <b>blast</b>
      </Link>
      <IconButton
        aria-expanded={!mini}
        aria-label={mini ? "Expand sidebar" : "Collapse sidebar"}
        className={styles.railToggle}
        onClick={() => setShellPref("railMini", !mini)}
        size="chip"
        title={mini ? "Expand" : "Collapse"}
      >
        <PanelLeftIcon />
      </IconButton>
    </div>
  );
}

function RailItem({
  item,
  label,
  href,
  icon,
  current,
  onAction,
  prefetch,
}: Readonly<{
  item: ShellNavKey;
  label: string;
  href: string | null;
  icon: ReactNode;
  current: ShellNavKey | null;
  onAction?: () => void;
  prefetch?: boolean;
}>) {
  const content = (
    <>
      {icon}
      <span>{label}</span>
    </>
  );
  if (href === null) {
    return (
      <button className={styles.navItem} onClick={onAction} type="button">
        {content}
      </button>
    );
  }
  return (
    <Link
      aria-current={current === item ? "page" : undefined}
      className={styles.navItem}
      href={href}
      prefetch={prefetch}
    >
      {content}
    </Link>
  );
}

function NotificationsIconLink({
  href,
  count,
  current,
  onAction,
  subscribeArrivals,
}: Readonly<{ href: string | null; count: number; current: boolean; onAction: () => void; subscribeArrivals?: SubscribeNotificationArrivals }>) {
  const halo = useRef<HTMLSpanElement>(null);
  const badgeRef = useRef<HTMLElement>(null);
  useNotificationFeedback(subscribeArrivals, halo, badgeRef);
  const label = count > 0 ? `Notifications, ${count} unread` : "Notifications";
  const dot = <NotificationBadge count={count} ref={badgeRef} />;
  const pulse = <span aria-hidden="true" className={styles.notificationHalo} ref={halo} />;
  if (href === null) {
    return (
      <IconButton aria-label={label} className={styles.nb} onClick={onAction} size="chip" title="Notifications">
        <BellIcon />
        {pulse}
        {dot}
      </IconButton>
    );
  }
  return (
    <IconButtonLink
      aria-current={current ? "page" : undefined}
      aria-label={label}
      className={styles.nb}
      href={href}
      size="chip"
      title="Notifications"
    >
      <BellIcon />
      {pulse}
      {dot}
    </IconButtonLink>
  );
}

function NotificationBadge({ count, ref }: Readonly<{ count: number; ref: React.RefObject<HTMLElement | null> }>) {
  const [lastCount, setLastCount] = useState(count);
  if (count > 0 && count !== lastCount) setLastCount(count);
  if (lastCount === 0) return null;
  return <em aria-hidden="true" className={styles.badgeDot} data-empty={count === 0 ? "" : undefined} ref={ref}>{lastCount > 99 ? "99+" : lastCount}</em>;
}

function TabItem({
  item,
  label,
  href,
  icon,
  current,
  prefetch,
}: Readonly<{ item: ShellNavKey; label: string; href: string; icon: ReactNode; current: ShellNavKey | null; prefetch?: boolean }>) {
  return (
    <Link aria-current={current === item ? "page" : undefined} href={href} prefetch={prefetch}>
      {icon}
      {label}
    </Link>
  );
}

/**
 * The right column (FEATURE-MAP §1.6): sticky so a tall column scrolls with
 * the page until its end, then sticks (`top = min(0, viewport − height)`),
 * with its first card level with the page's first surface. On Home it has
 * the "Trending coins" header and folds to a 44px expand button.
 */
function ShellAside({
  home,
  collapsed,
  mini,
  actions,
  pathname,
  children,
}: Readonly<{
  home: boolean;
  collapsed: boolean;
  mini?: ReactNode;
  actions?: ReactNode;
  pathname: string | null;
  children: ReactNode;
}>) {
  const asideRef = useRef<HTMLElement>(null);
  const fullRef = useRef<HTMLDivElement>(null);
  const miniButton = useRef<HTMLButtonElement>(null);
  const fullButton = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const aside = asideRef.current;
    if (!aside) return;
    const place = () => {
      if (getComputedStyle(aside).display === "none") return;
      const shell = aside.parentElement;
      const head = document.getElementById("view")?.querySelector<HTMLElement>("[data-page-head]");
      const next = head?.nextElementSibling;
      const surface = document.getElementById("cr-token")?.querySelector(".sbox") ?? (next?.matches(SURFACE) ? next : (next?.querySelector(SURFACE) ?? next));
      const card = fullRef.current?.querySelector<HTMLElement>("[data-aside-card], .card");
      const headerHeight = shell?.querySelector("[data-shell-topbar]")?.getBoundingClientRect().height ?? 0;
      if (!head?.closest("[data-sale-page]") && !collapsed && shell && surface && card) {
        const cardOffset = card.getBoundingClientRect().top - aside.getBoundingClientRect().top;
        const pageOffset = surface.getBoundingClientRect().top - (document.getElementById("main")?.getBoundingClientRect().top ?? 0);
        aside.style.marginTop = `${Math.max(0, pageOffset - cardOffset)}px`;
      } else {
        aside.style.marginTop = "";
      }
      aside.style.top = `${collapsed ? headerHeight : Math.min(headerHeight, window.innerHeight - aside.offsetHeight)}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(aside);
    const view = document.getElementById("view");
    if (view) observer.observe(view);
    window.addEventListener("resize", place);
    // A card's own entrance can change its measured position until it rests.
    aside.addEventListener("animationend", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      aside.removeEventListener("animationend", place);
    };
  }, [collapsed, pathname]);

  const toggle = (from: "full" | "mini") => {
    const source = from === "full" ? fullButton.current : miniButton.current;
    const focused = document.activeElement === source;
    setShellPref("asideCollapsed", !collapsed);
    // Focus moves to the button in the other layer once it shows.
    const target = from === "full" ? miniButton.current : fullButton.current;
    const root = source?.closest("[data-blast-ui]");
    const moveFocus = () => {
      if (!focused || !target?.isConnected || root?.getAttribute("data-aside") !== (from === "full" ? "collapsed" : "open")) return;
      if (document.activeElement !== source && document.activeElement !== document.body) return;
      if (getComputedStyle(target).visibility === "hidden") window.requestAnimationFrame(moveFocus);
      else target.focus({ preventScroll: true });
    };
    window.requestAnimationFrame(moveFocus);
  };

  return (
    <aside aria-label={pathname === "/create" || pathname === "/dev/social/create" ? "Presale preview and publishing" : pathname === "/launch" ? "Launch preview and launching" : home ? "Trending coins" : "What's happening"} className={styles.aside} data-shell-column="" id="aside" ref={asideRef}>
      <div className={clsx(styles.asideLayer, styles.asideFull)} key={pageIdentity(pathname)} ref={fullRef}>
        {home ? (
          <div className={styles.asideHead}>
            <h2>Trending coins</h2>
            <span className={styles.asideActs}>
              {actions}
              <button
                aria-controls="aside"
                aria-expanded={!collapsed}
                aria-label="Collapse trending coins"
                className="icon-btn"
                onClick={() => toggle("full")}
                ref={fullButton}
                title="Collapse"
                type="button"
              >
                <PanelRightIcon />
              </button>
            </span>
          </div>
        ) : null}
        {children}
      </div>
      {home ? (
        <div className={clsx(styles.asideLayer, styles.asideMini)}>
          <button
            aria-controls="aside"
            aria-expanded={!collapsed}
            aria-label="Expand trending coins"
            className={clsx("icon-btn", styles.asideExpand)}
            onClick={() => toggle("mini")}
            ref={miniButton}
            title="Expand"
            type="button"
          >
            <PanelRightIcon />
          </button>
          {mini}
        </div>
      ) : null}
    </aside>
  );
}
