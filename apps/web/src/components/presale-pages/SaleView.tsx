"use client";

import { DateStamp } from "#web/components/blast-ui/DateStamp.tsx";
import { fundingCap } from "./catalog-model";

import { CheckIcon, COIN_VERIFIED_LABEL, CoinVerifiedMark, DotsIcon, PencilIcon, PreviousIcon } from "#web/components/blast-ui/Icons.tsx";
import { pageLabel, PRESALES_PATH } from "#web/components/blast-ui/nav.ts";
import { Button, DisclosureButton, DisclosureSummary, IconButton, IconButtonLink } from "#web/components/blast-ui/Button.tsx";
import { CoinTypeTag } from "#web/components/blast-ui/CoinTypeTag.tsx";
import { CopyAddress } from "#web/components/blast-ui/CopyAddress.tsx";
import { CoinCover, CoinIdentityHeader, CoinTradingActivity } from "#web/components/social/bonding/CoinPageParts.tsx";
import { BlastMenu, BlastMenuItem, BlastMenuLinkItem, BlastMenuTrigger } from "#web/components/blast-ui/BlastMenu.tsx";
import { usePhoneLayout } from "#web/components/blast-ui/use-shell-prefs.ts";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { Segmented } from "#web/components/blast-ui/Segmented.tsx";
import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { useFeedbackReveal } from "#web/components/blast-ui/feedback-motion.ts";

import { vestingDurationText } from "@blast/core/web/contracts/vesting.ts";

import clsx from "clsx";
import { usePathname, useSearchParams } from "next/navigation";
import { useListOrigin } from "#web/components/blast-ui/list-restoration.ts";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { presaleDetailQuery } from "#web/components/social/queries.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { SaleAccessCard } from "./SaleAccess";
import { DexIdentity } from "#web/components/blast-ui/DexIdentity.tsx";
import { IntentLink as Link } from "#web/components/blast-ui/NavigationLink.tsx";
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";

import { NOT_OPEN_YET, ago, atomsValue, bpsShare, opensAt, ppmPct, px, qm, qp, qty, quoteOf, readsInCoin, shortAddress, usd, usd0, usdc } from "@blast/core/web/format.ts";
import { coreCoin } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { bpsMultiple } from "@blast/core/lib/bps.ts";
import { useShellActions } from "#web/components/blast-ui/shell-actions.tsx";
import { useToast } from "#web/components/blast-ui/Toasts.tsx";
import { coinCount, wholeCount } from "#web/components/blast-ui/tween-num.ts";
import { CoinTweenNum, TweenNum } from "#web/components/blast-ui/use-tween-num.tsx";
import { Sparkline } from "#web/components/charts/Sparkline.tsx";
import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import { discussionQuery } from "#web/components/social/coin-home/home-client.ts";
import { splitShades } from "#web/components/social/create/create-colors.ts";
import { sparkOf, usePrice } from "#web/components/social/prices/price-client.ts";
import { encodeTradeAction } from "#web/components/social/coins/swap-model.ts";
import { useSignInGate, useSocialViewer } from "#web/components/social/SignInGate.tsx";
import { useHeldBlast, type HeldBlastTarget } from "#web/components/social/commit/use-held-blast.ts";
import { useViewerFollow, useViewerStateStore } from "#web/components/social/ViewerState.tsx";
import { portfolioTabAt } from "#web/components/blast-ui/portfolio-navigation.ts";
import { presalePreviewUrl, presaleXIntent } from "#web/modules/presale/share/metadata.ts";
import type { FeedItem } from "@blast/core/web/contracts/items.ts";
import { tradesInApp } from "@blast/core/web/contracts/trades.ts";
import type { PresaleMomentumWindow, SocialPresaleBacker, SocialPresaleDetail, SocialPresaleRecipient, SocialPresaleViewerEntry } from "@blast/core/web/contracts/presales.ts";

import { ProgressBar } from "#web/components/blast-ui/ProgressBar.tsx";
import { PersonAvatar } from "#web/components/social/PersonAvatar.tsx";
import { ArtworkMark } from "#web/components/blast-ui/ArtworkMark.tsx";
import { RelTag, TimeLeft, WalletAvatar } from "./bits";

import { dyn } from "#web/components/blast-ui/csp-style.ts";
import { cx } from "./cx";
import { BuyerVestingCard } from "./BuyerVestingCard";
import { heldTargetOfSale } from "./held-target";
import { BellIcon, ChevIcon, LockIcon, RocketIcon, ShieldIcon, StarIcon } from "./icons";
import { PHASE_LABEL, barStage, fundingState, isOversubscribed, teamUnlockState, n, nextFigure, perWalletText, saleMoney, saleShare, saleShort, vestPlain } from "@blast/core/modules/presale/presentation.ts";
import { saleChartMarks } from "./raise-geometry";
import { RaiseChart, type ChartMark, type ChartOverlays } from "./RaiseChart";
import { SaleMarket } from "./SaleMarket";
import { SaleTradeFeed, SaleTrades } from "./SaleTrades";
import type { SocialSaleMetadata } from "@blast/core/web/contracts/sales.ts";
import { PresaleCover } from "./PresaleCover";
import { CoverButton, EditDetailsSheet, SaleLinks, useSaleDetails } from "./SaleDetails";


/** "See all" in the right column asks the page to show the Backers tab with "Following only" on. */
export const SHOW_FOLLOWING_EVENT = "blast:presale-show-following";

/** The watchlist hook (a later section): the star shows only when a page passes it. */
export type SaleWatch = Readonly<{ on: boolean; toggle: () => void }>;

/** The commit hook: the commit dialog (§4/§11) registers it once the presale contract is live. */
export type SaleCommit = Readonly<{ open: (presaleId: string) => void }>;

/** The back link names the page the reader came from (same site), else Presales. */
function referrerLabel(path: string, current: string): string | null {
  if (path.startsWith("/@")) {
    try {
      return decodeURIComponent(path.slice(1));
    } catch {
      return null;
    }
  }
  const portfolioTab = portfolioTabAt(path);
  if (portfolioTab !== null) return `Back to ${portfolioTab}`;
  return path === PRESALES_PATH && path === current ? null : pageLabel(path);
}

const navigationUrl = () => window.location.href;
const serverNavigationUrl = () => "";

function subscribeNavigationUrl(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  if ("navigation" in window) window.navigation.addEventListener("currententrychange", onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    if ("navigation" in window) window.navigation.removeEventListener("currententrychange", onChange);
  };
}

function contextualBack(url: string, origin: string | null) {
  const fallback = { label: "Presales", href: PRESALES_PATH, history: false };
  if (!url) return fallback;
  try {
    const previous = "navigation" in window
      ? window.navigation.entries()[(window.navigation.currentEntry?.index ?? 0) - 1]?.url
      : origin ?? document.referrer;
    if (!previous || window.history.length < 2) return fallback;
    const from = new URL(previous);
    if (from.origin !== window.location.origin) return fallback;
    const label = referrerLabel(from.pathname, window.location.pathname);
    return label ? { label, href: `${from.pathname}${from.search}`, history: true } : fallback;
  } catch {
    return fallback;
  }
}

function BackBar() {
  // Next can render the detail before history commits; read again when it does.
  const route = usePathname();
  const search = useSearchParams();
  const origin = useListOrigin(`${route}?${search?.toString() ?? ""}`);
  const url = useSyncExternalStore(subscribeNavigationUrl, navigationUrl, serverNavigationUrl);
  const back = contextualBack(url, origin);
  return (
    <div className={cx("backbar")} data-page-head="">
      <Link
        href={back.href}
        onClick={(event) => {
          if (!back.history || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
          event.preventDefault();
          window.history.back();
        }}

      >
        <PreviousIcon />
        {back.label}
      </Link>
    </div>
  );
}

function FollowSale({ detail }: Readonly<{ detail: SocialPresaleDetail }>) {
  const gate = useSignInGate();
  const store = useViewerStateStore();
  const sale = detail.presale;
  const target = { kind: "presale", presale_id: sale.presale_id } as const;
  const on = useViewerFollow(target) === true;
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const label = (
    <>
      <span className={cx("l-off")}>Follow</span>
      <span className={cx("l-on")}>Following</span>
      <span className={cx("l-hover")}>Unfollow</span>
    </>
  );
  if (!gate.signedIn) {
    return (
      <Link className={cx("btn btn-ink follow")} href={gate.signInHref} onClick={gate.openSignIn}>
        {label}
      </Link>
    );
  }
  return (
    <button
      aria-pressed={on}
      className={cx("btn btn-ink follow", on && "on")}
      disabled={busy}
      onClick={async () => {
        if (busy || !store) return;
        setBusy(true);
        // The button frees itself even when the write throws.
        await store.setFollowing(target, !on)
          .then((result) => {
            if (result.status !== "ok") toast("That didn't save", { sub: "Nothing changed. Try again in a moment." });
          })
          .catch(() => toast("That didn't save", { sub: "Nothing changed. Try again in a moment." }))
          .finally(() => setBusy(false));
      }}
      type="button"
    >
      {label}
    </button>
  );
}

/**
 * The trust pills read the operator's flags. The pink Known deployer badge
 * sits beside the sale name. The coin page also shows the on-chain LP lock.
 */
export function TrustBadges({ sale, lpLocked = false }: Readonly<{ sale: Pick<SocialPresaleDetail["presale"], "verified_team" | "audited">; lpLocked?: boolean }>) {
  return (
    <>
      {lpLocked ? <span className={cx("sale-pill")}><LockIcon />LP locked</span> : null}
      {sale.verified_team ? null : <span className={cx("sale-pill warn")}><ShieldIcon />Project team unconfirmed</span>}
      {sale.audited ? <span className={cx("sale-pill")}>Audited</span> : null}
    </>
  );
}

/** The coin's name, ticker and Known deployer badge. */
function SaleName({ sale }: Readonly<{ sale: SocialPresaleDetail["presale"] }>) {
  const ticker = `$${sale.symbol.replace(/^\$/, "")}`;
  const distinct = sale.name.trim().replace(/^\$/, "").toLowerCase() !== ticker.slice(1).toLowerCase();
  return (
    <div className={cx("sale-name-row")}>
      <h1 className={cx("sale-name")}>{distinct ? sale.name : ticker} <span className={cx("sale-ticker")}>{distinct ? ticker : null}</span></h1>
      {sale.verified_team ? <span className="coinVerifiedPill" title={COIN_VERIFIED_LABEL}><CoinVerifiedMark decorative size="lg" />{COIN_VERIFIED_LABEL}</span> : null}
    </div>
  );
}

function SaleCreator({ creator }: Readonly<{ creator: SocialPresaleDetail["creator"] }>) {
  if (!creator) return null;
  const { wallet, account } = creator;
  const name = account ? account.display_name ?? `@${account.callsign}` : undefined;
  return (
    <span className={cx("sale-creator")}>
      <CopyAddress value={wallet} label="Created by" copyLabel="Copy creator wallet address" name={name} />
      {account ? (
        <IconButtonLink
          aria-label={`View profile for ${name}`}
          href={`/@${account.callsign}`}
          prefetch={false}
          size="xs"
          title={`View profile for ${name}`}
        >
          <PersonAvatar person={account} size={18} />
        </IconButtonLink>
      ) : null}
    </span>
  );
}

function SaleIdentityMeta({ detail }: Readonly<{ detail: SocialPresaleDetail }>) {
  if (!detail.creator && !detail.presale.sale_token) return null;
  return <span className={cx("sale-meta")}>
    <SaleCreator creator={detail.creator} />
    <CoinTypeTag coinType={detail.presale.sale_token} />
  </span>;
}

function SaleLinksMenu({ sale, metadata }: Readonly<{ sale: SocialPresaleDetail["presale"]; metadata: SocialSaleMetadata | null }>) {
  const toast = useToast();
  const url = presalePreviewUrl({ ...sale, metadata });
  async function copy(value: string, message: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast(message);
    } catch {
      toast("Copying isn't allowed here");
    }
  }
  async function share() {
    if (typeof navigator.share !== "function") {
      await copy(url, "Link copied");
      return;
    }
    try {
      await navigator.share({ url, title: `${sale.name} on Blast` });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) toast("Sharing isn't allowed here");
    }
  }
  return (
    <span className={cx("sale-links-menu")}>
      <BlastMenu
        className={cx("discovery-menu")}
        label="Presale links"
        placement={() => ({ side: "bottom", align: "end", sideOffset: 6, avoid: "flip", originX: "calc(100% - 18px)" })}
        trigger={<BlastMenuTrigger aria-label="Presale links" render={<IconButton aria-label="Presale links" size="touch" variant="secondary"><DotsIcon /></IconButton>} />}
      >
        <BlastMenuItem className={cx("discovery-option")} closeOnClick onClick={share}>Share…</BlastMenuItem>
        <BlastMenuItem className={cx("discovery-option")} closeOnClick onClick={() => copy(url, "Link copied")}>Copy link</BlastMenuItem>
        <BlastMenuItem className={cx("discovery-option")} closeOnClick onClick={() => copy(sale.sale_token, "Coin address copied")}>Copy coin address</BlastMenuItem>
        <BlastMenuLinkItem className={cx("discovery-option")} href={presaleXIntent({ ...sale, metadata })} rel="noopener noreferrer" target="_blank">Share on X</BlastMenuLinkItem>
      </BlastMenu>
    </span>
  );
}

function SaleWatchButton({ watch }: Readonly<{ watch?: SaleWatch }>) {
  if (!watch) return null;
  const label = watch.on ? "On your watchlist" : "Add to watchlist";
  return <IconButton aria-label={label} aria-pressed={watch.on} className={cx("watchlist")} onClick={watch.toggle} size="touch" title={label} variant="secondary">
    <StarIcon />
  </IconButton>;
}

/** The identity's actions: Watchlist, links and Follow (ink); a creator gets the cover and details editing instead of Follow. */
function SaleActions({ detail, watch, details, onEdit }: Readonly<{ detail: SocialPresaleDetail; watch?: SaleWatch; details: ReturnType<typeof useSaleDetails>; onEdit: () => void }>) {
  const sale = detail.presale;
  const { metadata, editable } = details;
  return (
    <span className={cx("sale-actions")}>
      <SaleWatchButton watch={watch} />
      <SaleLinksMenu metadata={metadata} sale={sale} />
      {editable ? (
        <>
          <CoverButton details={details} sale={sale} />
          <IconButton aria-haspopup="dialog" aria-label="Edit details" onClick={onEdit} size="touch" title="Edit details" variant="secondary"><PencilIcon /></IconButton>
        </>
      ) : null}
      {sale.phase === "pending" || editable ? null : <FollowSale detail={detail} />}
    </span>
  );
}

/**
 * The Sale board's head: the creator's cover (cropped on phones; the sale's
 * palette until one loads) with the coin mark over its lower-left corner,
 * then the name and ticker, the stage and trust pills, the meta line and
 * the actions. It spans the page and the right column on wide screens.
 */
function SaleHead({ detail, watch, now }: Readonly<{ detail: SocialPresaleDetail; watch?: SaleWatch; now: number }>) {
  const sale = detail.presale;
  const phase = fundingState(detail, now).phase;
  const details = useSaleDetails(sale);
  const [editing, setEditing] = useState(false);
  const { metadata, editable } = details;
  return (
    <>
      <div className={cx("sale-cover")}>
        <PresaleCover className={cx("sale-cover-art")} cover={metadata?.cover} eager presaleId={sale.presale_id} />
        <ArtworkMark coinType={sale.coin_type} src={sale.icon_url} fallbackId={sale.presale_id} size={84} />
      </div>
      <div className={cx("sale-id")}>
        <div className={cx("sale-id-text")}>
          <SaleName sale={sale} />
          <span className={cx("sale-pills")}>
            <span className={cx("status sale-status")} data-tone={phase}>{PHASE_LABEL[phase]}</span>
            <TrustBadges sale={sale} />
          </span>
          <SaleIdentityMeta detail={detail} />
        </div>
        <SaleActions details={details} detail={detail} onEdit={() => setEditing(true)} watch={watch} />
      </div>
      {editable ? <EditDetailsSheet details={details} onClose={() => setEditing(false)} open={editing} sale={sale} /> : null}
    </>
  );
}

function CoinHead({ detail, watch }: Readonly<{ detail: SocialPresaleDetail; watch?: SaleWatch }>) {
  const sale = detail.presale;
  const details = useSaleDetails(sale);
  const [editing, setEditing] = useState(false);
  return <>
    <CoinIdentityHeader
      coin={{ key: sale.presale_id, coinType: sale.sale_token, iconUrl: sale.icon_url, round: false }}
      name={sale.name}
      symbol={sale.symbol.replace(/^\$/, "")}
      status="Graduated"
      graduated
      mark={sale.verified_team ? <CoinVerifiedMark /> : null}
      actions={<SaleActions details={details} detail={detail} onEdit={() => setEditing(true)} watch={watch} />}
    >
      <SaleCreator creator={detail.creator} />
    </CoinIdentityHeader>
    {details.editable ? <EditDetailsSheet details={details} onClose={() => setEditing(false)} open={editing} sale={sale} /> : null}
  </>;
}

/** An upcoming sale's tiles: when it opens (its date is the state line's) and who is waiting. */
function pendingTiles(sale: SocialPresaleDetail["presale"], now: number): (readonly [string, ReactNode])[] {
  const opens = <TimeLeft now={now} to={sale.start_ms} />;
  return [
    ["Opens in", opensAt(sale.start_ms) === null ? NOT_OPEN_YET : opens],
    ["Interested", sale.interested.toLocaleString("en-US")],
  ];
}

/** An opened sale's tiles: its time left or when it closed, and its backers. */
function raiseTiles(detail: SocialPresaleDetail, now: number): (readonly [string, ReactNode])[] {
  const sale = detail.presale;
  const funding = fundingState(detail, now);
  const next = nextFigure(sale.phase === "open" ? { ...sale, phase: "closed" } : sale);
  // The gate's `[data-ppl]`: the backers count to the new figure after a commit (`paintRaise`).
  const backers = <TweenNum format={wholeCount} value={sale.participants} />;
  const left = <TimeLeft now={now} to={sale.end_ms} />;
  const at = <DateStamp at={next.at} label={`${next.label.toLowerCase()} time`} />;
  return [
    ...(funding.open ? [["Ends in", left] as const] : next.at === null ? [] : [[next.label, at] as const]),
    ["Backers", backers],
  ];
}

/** The raise's tiles, each left out with its label when the sale has no such fact. */
function RaiseTiles({ detail, now }: Readonly<{ detail: SocialPresaleDetail; now: number }>) {
  const sale = detail.presale;
  const tiles = sale.phase === "pending" ? pendingTiles(sale, now) : raiseTiles(detail, now);
  // Trading pages show supply with their Tokenomics card.
  const supply = sale.phase === "trading" ? null : atomsValue(detail.terms?.supply.total, sale.sale_decimals);
  if (supply !== null) {
    const amount = qty(supply).replace(/M$/, "\u00a0million").replace(/B$/, "\u00a0billion");
    const burnable = detail.terms?.burnable;
    tiles.unshift(["Total supply", <>{amount}{burnable == null ? null : <small className={cx("sale-supply-status")}>{` · ${burnable ? "Burnable" : "Fixed"}`}</small>}</>]);
  }
  const venue = <DexIdentity iconOnly venue={sale.venue} />;
  if (sale.phase !== "cancelled") tiles.push(["Launches on", venue]);
  return (
    <span className={cx("sale-tiles")}>
      {tiles.map(([label, value]) => <span data-raise-fact={label} key={label}><span>{label}</span><b className="num">{value}</b></span>)}
    </span>
  );
}

/**
 * The Sale board's main card: the raise in its own coin (R3-40) with its
 * target and, for a coin-quoted sale, its dollars; the fill; the tiles. An
 * upcoming sale leads with its target instead.
 */
function RaiseCard({ detail, now }: Readonly<{ detail: SocialPresaleDetail; now: number }>) {
  const sale = detail.presale;
  const funding = fundingState(detail, now);
  const quote = quoteOf(sale);
  const target = qm(quote, { usd: sale.target_usd, atoms: sale.target_atoms }) ?? "Unavailable";
  const currency = coreCoin(sale.quote_type);
  const coin = { key: sale.quote_type, coinType: sale.quote_type, iconUrl: currency?.logoUrl ?? null, round: true, symbol: sale.quote_symbol };
  const pending = sale.phase === "pending";
  const dollars = readsInCoin(quote) && sale.raised_usd !== null && !pending ? ` · ≈ ${usd0(n(sale.raised_usd))}` : "";
  return (
    <section aria-label="Raise" className={cx("card sale-raise")} data-phase={funding.phase}>
      <span className={cx("sale-raised")}>
        <CoinMark coin={coin} size={28} />
        {/* The gate's `[data-raised0]`: it counts to the new figure after a commit, in the sale's own coin (R3-40). */}
        <b className="num">{pending ? target : <RaisedTween sale={sale} />}</b>{" "}
        <span className="num">{pending ? "target" : `of ${target}${dollars}`}</span>
      </span>
      {pending ? null : (
        <div className={cx("sale-raise-progress")}>
          <div aria-label="Committed toward target" aria-valuemin={0} aria-valuemax={100} aria-valuenow={funding.progress} aria-valuetext={`${funding.percentage} of target; ${funding.label}; ${funding.participation}`} className={cx("sale-raise-bar")} data-progress-bar="" data-stage={barStage(sale.phase) ?? undefined} role="progressbar">
            {/* `data-bar`: the gate's own attribute; a held blast's ball lands here (R3-13). */}
            <i data-bar={sale.presale_id} {...dyn({ width: `${funding.progress}%` })} />
          </div>
          {funding.relationship === "unknown" ? null : <span aria-hidden="true" className={clsx(cx("sale-raise-percent"), "num")}>{funding.percentage.replace(/\.00%$/, "%")} funded</span>}
        </div>
      )}
      <RaiseTiles detail={detail} now={now} />
    </section>
  );
}

/** The notice's parts for a sale's state: the stage's facts in order, venues as their icons. */
function noticeParts(detail: SocialPresaleDetail, now: number): readonly Readonly<{ id: string; content: ReactNode }>[] {
  const sale = detail.presale;
  const funding = fundingState(detail, now);
  const trades = { id: "trades", content: <>Then trades on <DexIdentity iconOnly venue={sale.venue} /></> };
  if (funding.phase === "cancelled") {
    const reason = funding.relationship === "below" ? "The target was missed." : "Sale cancelled.";
    return [{ id: "cancelled", content: `${reason} Everyone can claim a full refund.` }];
  }
  if (sale.phase === "pending") {
    const opens = opensAt(sale.start_ms);
    return [{ id: "opens", content: opens === null ? `${NOT_OPEN_YET}, no date set` : <>Opens <DateStamp at={opens} label="presale opening time" /></> }, trades];
  }
  if (funding.phase === "funded") return [{ id: "funded", content: "Funded" }, { id: "claims", content: <>Claims open when trading starts on <DexIdentity iconOnly venue={sale.venue} /></> }];
  if (!funding.open) return [{ id: "closed", content: <>Closed <DateStamp at={sale.end_ms} label="presale closing time" /></> }, { id: "settlement", content: "The result settles on chain shortly." }];
  const reached = funding.relationship === "reached" || funding.relationship === "oversubscribed";
  return [
    ...(reached ? [{ id: "funding", content: funding.label }] : []),
    ...(funding.participation === "Commitments open" ? [] : [{ id: "participation", content: funding.participation }]),
    { id: "opened", content: <>Opened <DateStamp at={sale.opened_ms ?? sale.start_ms} label="presale opening time" /></> },
    { id: "closes", content: <>Closes <DateStamp at={sale.end_ms} label="presale closing time" /></> },
    trades,
  ];
}

/** One muted line per sale state under the main card (the Sale board's notice). */
function SaleNotice({ detail, now }: Readonly<{ detail: SocialPresaleDetail; now: number }>) {
  return (
    <p className={cx("card sale-notice num")} role="status">
      {noticeParts(detail, now).map((part) => <span data-notice={part.id} key={part.id}>{part.content}</span>)}
    </p>
  );
}

/** "People you follow" in this sale (the Sale board's card): the five largest, then "See all N". */
export function FriendsCard({
  detail,
  entry,
  narrow,
  onSeeAll,
}: Readonly<{ detail: SocialPresaleDetail; entry: SocialPresaleViewerEntry | null; now?: number; narrow?: boolean; onSeeAll: () => void }>) {
  const sale = detail.presale;
  const list = entry?.following ?? [];
  if (sale.phase === "pending" || list.length === 0) return null;
  return (
    <section aria-label={`People you follow in ${sale.name}`} className={cx("card friends", narrow && "only-narrow")}>
      <h2>People you follow</h2>
      <div className={cx("fr-list")}>
        {list.slice(0, 5).map((row) => (
          <Link className={cx("fr-row")} href={`/@${row.account.callsign}`} key={row.account.callsign}>
            <PersonAvatar person={row.account} size={34} />
            <span className={cx("t")}>
              <b>{row.account.display_name ?? `@${row.account.callsign}`}</b>
              {row.why ? <span className={cx("fr-why")}>{row.why}</span> : null}
            </span>
            <b className={cx("fr-amt num")}>{qm(quoteOf(sale), { usd: row.commitment_usd, atoms: row.commitment_atoms }, readsInCoin(quoteOf(sale)) ? 2 : 0) ?? "Unavailable"}</b>
          </Link>
        ))}
      </div>
      {list.length > 5 ? (
        <Button className={cx("fr-more")} onClick={onSeeAll} size="sm" variant="ghost">
          See all {list.length}
        </Button>
      ) : null}
    </section>
  );
}

/**
 * The raise counting to its new total (OA-28 M3) in the sale's own coin
 * (R3-40): a USDC sale's dollars, a coin-quoted sale's coins. At rest it is
 * the read's exact figure (`saleMoney`); only the frames in between are
 * rounded.
 */
function RaisedTween({ sale }: Readonly<{ sale: SocialPresaleDetail["presale"] }>) {
  const quote = quoteOf(sale);
  if (!readsInCoin(quote) && sale.raised_usd === null) return <>Unavailable</>;
  if (!readsInCoin(quote)) return <TweenNum format={usdc} value={n(sale.raised_usd)} />;
  const count = coinCount(quote, sale.raised_atoms);
  return count === null ? <>{saleMoney(sale, sale.raised_usd, sale.raised_atoms)}</> : <CoinTweenNum count={count} />;
}

/**
 * "Since launch": the presale price, the price now, the multiple, and the
 * coin's line since it started trading (160×40, R3-20's
 * `GET /api/social/prices?window=launch`), coloured by the multiple as the
 * gate's is. The line's place stays empty without a price history.
 */
function SinceLaunch({ detail }: Readonly<{ detail: SocialPresaleDetail }>) {
  const sale = detail.presale;
  // The presale price in the sale's coin (`qp`); the coin's price now in dollars, as the gate draws it (`px(s.now)`).
  const entry = qp(quoteOf(sale), { usd: sale.presale_price_usd, quote: sale.presale_price_quote });
  const trading = sale.phase === "trading" && entry !== null && sale.price_usd !== null;
  const price = usePrice(trading ? { presaleId: sale.presale_id, window: "launch" } : null);
  if (!trading) return null;
  const multipleValue = n(sale.multiple);
  return (
    <section className={cx("card sale-card")}>
      <div className={cx("sec-title")}>
        <h3>Since launch</h3>
        <span>Trading on <DexIdentity iconOnly venue={sale.venue} /></span>
      </div>
      <div className={cx("since")}>
        <div><span>Presale price</span><b className={cx("num")}>{entry}</b></div>
        <ChevIcon className={cx("chev")} />
        <div><span>Now</span><b className={cx("num")}>{px(n(sale.price_usd))}</b></div>
        <div className={cx("mult", multipleValue >= 1 ? "up" : "down")}>{multipleValue.toFixed(1)}×</div>
        <Sparkline className={cx("spark")} height={40} points={sparkOf(price)} slot="since-sparkline" up={multipleValue >= 1} width={160} />
      </div>
    </section>
  );
}

const WINDOWS: readonly (readonly [PresaleMomentumWindow, string])[] = [["5m", "5M"], ["1h", "1H"], ["4h", "4H"], ["1d", "1D"]];

function Momentum({ detail }: Readonly<{ detail: SocialPresaleDetail }>) {
  const [win, setWin] = useState<PresaleMomentumWindow>("1h");
  const m = detail.momentum[win];
  const money = (usd: string | null, atoms: string | null) => qm(quoteOf(detail.presale), { usd, atoms }, readsInCoin(quoteOf(detail.presale)) ? 2 : 0) ?? "Unavailable";
  const usdAvailable = !m.commits || m.average_usd !== null;
  return (
    <section className={cx("card sale-card")} id="momBox">
      <div className={cx("sec-title")}>
        <h3>Momentum</h3>
        <Segmented label="Window" onChange={setWin} options={WINDOWS} size="sm" value={win} />
      </div>
      <div className={cx("mtiles")}>
        <div><span>Commits</span><b className={cx("num")}>{m.commits}</b><em>{m.commits ? `${money(m.total_usd, m.total_atoms)} in` : "None yet"}</em></div>
        <div><span>New backers</span><b className={cx("num")}>{m.backers}</b><em>of {detail.presale.participants.toLocaleString("en-US")} in all</em></div>
        <div><span>Average commit</span><b className={cx("num")}>{m.commits ? money(m.average_usd, m.average_atoms) : "–"}</b><em>{m.commits ? `Median ${money(m.median_usd, m.median_atoms)}` : "No commits yet"}</em></div>
        <div>
          <span>Big vs small</span>
          {usdAvailable ? <><span className={cx("bs")}><i {...dyn({ width: `${m.big_bps / 100}%` })} /></span><em>{Math.round(m.big_bps / 100)}% from $1K+ commits</em></> : <em>USD breakdown unavailable</em>}
        </div>
      </div>
    </section>
  );
}

type TabKey = "backers" | "thesis" | "activity";

/** The backers table lists at most this many (the read's largest). */
const BACKERS_MAX = 25;
/** It shows this many until "Show N more" (OA-24). */
export const BACKERS_FIRST = 10;

/**
 * The followed backers as table rows: their share of the raise from the
 * atoms, exactly (one sale, one unit), as the read's own `share_bps`.
 */
function followedBackerRows(sale: SocialPresaleDetail["presale"], entry: SocialPresaleViewerEntry | null): SocialPresaleBacker[] {
  const raised = /^(0|[1-9][0-9]*)$/.test(sale.raised_atoms) ? BigInt(sale.raised_atoms) : 0n;
  return (entry?.following ?? []).map((row) => ({
    wallet: row.account.callsign,
    account: row.account,
    commitment_usd: row.commitment_usd,
    commitment_atoms: row.commitment_atoms,
    share_bps: raised > 0n ? Number((BigInt(row.commitment_atoms) * 10_000n) / raised) : 0,
    last_commit_ms: row.last_commit_ms,
    why: row.why,
  }));
}

function BackersTable({
  detail,
  entry,
  now,
  followingOnly,
  overOneK,
  onFilter,
}: Readonly<{
  detail: SocialPresaleDetail;
  entry: SocialPresaleViewerEntry | null;
  now: number;
  followingOnly: boolean;
  overOneK: boolean;
  onFilter: (key: "following" | "big") => void;
}>) {
  const followed = new Set(entry?.following.map((row) => row.account.callsign) ?? []);
  let rows: readonly SocialPresaleBacker[] = followingOnly ? followedBackerRows(detail.presale, entry) : detail.backers.top;
  if (overOneK) rows = rows.filter((row) => n(row.commitment_usd) >= 1_000);
  rows = rows.slice(0, BACKERS_MAX);
  // OA-24: ten rows first, then "Show N more"; a new filter starts clipped again, as the gate redraws the table.
  const filterKey = `${followingOnly}:${overOneK}`;
  const [opened, setOpened] = useState<string | null>(null);
  const clipped = opened !== filterKey && rows.length > BACKERS_FIRST;
  const shown = clipped ? rows.slice(0, BACKERS_FIRST) : rows;
  const top10 = detail.backers.top10_bps / 100;
  return (
    <>
      <div className={cx("conc")}>
        <span>Top 10 backers hold <b className={cx("num")}>{top10.toFixed(1)}%</b> of the raise</span>
        <ProgressBar pct={top10} small />
      </div>
      <div className={cx("bfilters")}>
        <button aria-pressed={followingOnly} className={cx("ovl", followingOnly && "on")} onClick={() => onFilter("following")} type="button">
          <CheckIcon strong />
          Following only
        </button>
        <button aria-pressed={overOneK} className={cx("ovl", overOneK && "on")} onClick={() => onFilter("big")} type="button">
          <CheckIcon strong />
          Over $1K
        </button>
      </div>
      <div className={cx("tbl-wrap")}>
        <table className={cx("tbl")}>
          <thead>
            <tr>
              <th className={cx("backer-desktop")}>#</th>
              <th>Backer</th>
              <th className={cx("r")}>Committed</th>
              <th className={cx("r backer-desktop")}>Of raise</th>
              <th className={cx("backer-desktop")}>When</th>
              <th className={cx("backer-desktop")}>Thesis</th>
              <th className={cx("backer-expand")}><span className="sr-only">Details</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td className={cx("muted")} colSpan={7}>No backers match.</td></tr>
            ) : shown.map((row, index) => (
              <BackerRow following={!!row.account && followed.has(row.account.callsign)} key={row.wallet} now={now} rank={index + 1} row={row} sale={detail.presale} />
            ))}
          </tbody>
        </table>
      </div>
      {clipped ? (
        <button className={cx("btn btn-quiet btn-sm bk-more")} onClick={() => setOpened(filterKey)} type="button">
          Show {rows.length - BACKERS_FIRST} more
        </button>
      ) : null}
      {!followingOnly && !overOneK && detail.presale.participants > BACKERS_MAX && rows.length >= BACKERS_MAX ? (
        <p className={cx("tbl-note")}>The 25 largest of {detail.presale.participants.toLocaleString("en-US")} backers</p>
      ) : null}
    </>
  );
}

function BackerRow({ following, now, rank, row, sale }: Readonly<{
  following: boolean;
  now: number;
  rank: number;
  row: SocialPresaleBacker;
  sale: SocialPresaleDetail["presale"];
}>) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const name = row.account ? row.account.display_name ?? `@${row.account.callsign}` : shortAddress(row.wallet);
  const quote = quoteOf(sale);
  const committed = qm(quote, { usd: row.commitment_usd, atoms: row.commitment_atoms }, readsInCoin(quote) ? 2 : 0) ?? "Unavailable";
  const share = `${(row.share_bps / 100).toFixed(2)}%`;
  const time = row.last_commit_ms === null ? "–" : ago(row.last_commit_ms, now);
  return <>
    <tr>
      <td className={cx("num muted backer-desktop")}>{rank}</td>
      <td>
        <span className={cx("bk")}>
          {row.account ? <PersonAvatar person={row.account} size={26} /> : <WalletAvatar address={name} />}
          {row.account ? <Link href={`/@${row.account.callsign}`}>{name}</Link> : <span className="mono">{name}</span>}
          {following ? <RelTag>Following</RelTag> : null}
        </span>
      </td>
      <td className={cx("num r")}>{committed}</td>
      <td className={cx("num r muted backer-desktop")}>{share}</td>
      <td className={cx("num muted backer-desktop")}>{time}</td>
      <td className={cx("th backer-desktop")}>{row.why ?? <span className={cx("muted")}>–</span>}</td>
      <td className={cx("backer-expand")}>
        <DisclosureButton aria-controls={expanded ? id : undefined} aria-expanded={expanded} aria-label={`Details for ${name}`} iconOnly onClick={() => setExpanded((open) => !open)} variant="ghost" />
      </td>
    </tr>
    {expanded ? <tr className={cx("backer-expanded")} id={id}>
      <td colSpan={3}>
        <dl className={cx("kv")}>
          <Row label="Rank">{rank}</Row>
          <Row label="Of raise">{share}</Row>
          <Row label="Last commit">{time}</Row>
          {following ? <Row label="Connection">Following</Row> : null}
          {row.why ? <Row label="Thesis">{row.why}</Row> : null}
        </dl>
      </td>
    </tr> : null}
  </>;
}

function Theses({ detail }: Readonly<{ detail: SocialPresaleDetail }>) {
  if (detail.theses.length === 0) return <EmptyState title="No thesis yet" />;
  return (
    <div className={cx("theses")}>
      {detail.theses.map((thesis) => (
        <article className={cx("thesis")} key={thesis.why_id}>
          <div className={cx("th-h")}>
            <PersonAvatar person={thesis.account} size={30} />
            <b>{thesis.account.display_name ?? `@${thesis.account.callsign}`}</b>
            <span className={cx("th-amt num")}>{thesis.commit_usd === null ? "" : `${usd(n(thesis.commit_usd))} in`}</span>
            <span aria-label={`${thesis.rockets.toLocaleString("en-US")} ${thesis.rockets === 1 ? "rocket" : "rockets"}`} className={cx("th-r")}>
              <RocketIcon />
              {thesis.rockets.toLocaleString("en-US")}
            </span>
          </div>
          <p>{thesis.text}</p>
        </article>
      ))}
    </div>
  );
}

/** A post's headline in the Activity tab, for lifecycle and milestone items (the design's copy). */
function headline(item: FeedItem, detail: SocialPresaleDetail): ReactNode {
  const name = detail.presale.name;
  const value = item.milestone_value ? Number(item.milestone_value) : 0;
  switch (item.kind) {
    case "presale_opened": return `${name} is open`;
    case "presale_funded": return `${name} is funded`;
    case "presale_migrated": return <>{name} is trading on <DexIdentity iconOnly venue={detail.presale.venue} /></>;
    case "presale_cancelled": return `${name} was cancelled`;
    case "milestone_participants": return `${value.toLocaleString("en-US")} people are in`;
    // The raise milestone's value is the target in quote atoms (`milestones/generate.ts`); it read as dollars of atoms before R3-40.
    case "milestone_raise": return `${saleShort(detail.presale, detail.presale.target_usd, item.milestone_value)} raised`;
    case "milestone_holders": return `${value.toLocaleString("en-US")} holders`;
    default: return name;
  }
}

/** A post's second line in the Activity tab (the design's post copy), or null. */
function subline(item: FeedItem, detail: SocialPresaleDetail): string | null {
  const sale = detail.presale;
  if (item.kind === "milestone_participants" && item.milestone_value) {
    const hours = Math.round((sale.end_ms - item.occurred_at_ms) / 3_600_000);
    const left = sale.phase === "open" && hours > 0 ? ` with ${hours} ${hours === 1 ? "hour" : "hours"} left` : "";
    return `${sale.name} passed ${Number(item.milestone_value).toLocaleString("en-US")} backers${left}.`;
  }
  if (item.kind === "presale_funded" && sale.fill_bps > 10_000) {
    return `${bpsMultiple(sale.fill_bps)} oversubscribed. Claims open when the pool launches.`;
  }
  if (item.kind === "presale_migrated" && sale.multiple !== null) {
    return `It now trades at ${n(sale.multiple).toFixed(1)}× the presale price. Backers can claim their tokens.`;
  }
  return null;
}

function ActivityRows({ detail, now, items, empty = "No activity yet" }: Readonly<{ detail: SocialPresaleDetail; now: number; items?: readonly FeedItem[]; empty?: string }>) {
  const activity = items ?? detail.activity;
  if (activity.length === 0) return <EmptyState title={empty} />;
  const sale = detail.presale;
  return (
    <div className={cx("fr-list act-list")}>
      {activity.map((item) => {
        const when = <span className={cx("when")}>{ago(item.occurred_at_ms, now)}</span>;
        if (!item.actor) {
          return (
            <div className={cx("fr-row")} key={item.entry_id}>
              <ArtworkMark coinType={sale.coin_type} src={sale.icon_url} fallbackId={sale.presale_id} size={34} />
              <span className={cx("t")}>
                <span className={cx("fr-top")}><b>{headline(item, detail)}</b>{when}</span>
                {subline(item, detail) ? <span className={cx("fr-why")}>{subline(item, detail)}</span> : null}
              </span>
            </div>
          );
        }
        const claim = item.kind === "presale_claim";
        const tokens = atomsValue(item.amounts?.tokens, sale.sale_decimals) ?? 0;
        // The gate's `usd(p.usd)` for every sale: a SUI commit's dollars at its own time.
        const amount = claim ? `${qty(tokens)} ${sale.symbol}` : item.amounts?.usd ? usd(n(item.amounts.usd)) : "";
        const name = item.actor.type === "account" ? (item.actor.display_name ?? `@${item.actor.callsign}`) : <span className="mono">{item.actor.short}</span>;
        const inner: ReactNode = (
          <>
            {item.actor.type === "account"
              ? <PersonAvatar person={{ callsign: item.actor.callsign, avatar_url: item.actor.avatar_url }} size={34} />
              : <WalletAvatar address={item.actor.short} size={34} />}
            <span className={cx("t")}>
              <span className={cx("fr-top")}>
                <b>{name}</b>
                <span className={cx("verb")}>{claim ? "claimed" : "blasted"}</span>
                {when}
                <span className={cx("fr-amt num")}>{amount}</span>
              </span>
              {item.why ? <span className={cx("fr-why")}>{item.why.text}</span> : null}
            </span>
          </>
        );
        return item.actor.type === "account" ? (
          <Link className={cx("fr-row")} href={`/@${item.actor.callsign}`} key={item.entry_id}>{inner}</Link>
        ) : (
          <div className={cx("fr-row")} key={item.entry_id}>{inner}</div>
        );
      })}
    </div>
  );
}

function AllocationRows({ parts }: Readonly<{ parts: readonly (readonly [string, number, string, string?])[] }>) {
  const visible = parts.filter(([, bps]) => bps > 0);
  const shades = splitShades(visible.map(([, bps]) => bps));
  return (
    <div className={cx("allocation-rows")}>
      {visible.map(([label, bps, amount, note], index) => (
        <div className={cx("sl")} key={label}>
          <span className={cx("dot")} {...dyn({ background: shades[index] })} />
          <span className={cx("t")}><b>{label}</b>{note ? <span>{note}</span> : null}</span>
          <span className={cx("v")}><b>{bpsShare(bps)}</b><span>{amount}</span></span>
        </div>
      ))}
    </div>
  );
}

function recipientLabel(recipient: SocialPresaleRecipient, index: number): readonly [string, string | undefined] {
  if (recipient.vesting) return ["Team", "Vesting"];
  return [index === 0 ? "Recipient" : `Recipient ${index + 1}`, shortAddress(recipient.address)];
}

/** The supply's caption: its size, then `burnable` or `fixed supply` once the terms read says which (R3-90). */
function supplyCaption(supply: string, burnable: boolean | null): string {
  return burnable === null ? supply : `${supply}, ${burnable ? "burnable" : "fixed supply"}`;
}

function teamUnlockRead(detail: SocialPresaleDetail, query: Readonly<{ isFetching: boolean; isError: boolean }>) {
  return query.isFetching && detail.terms === null ? "loading" : query.isError ? "error" : "ready";
}

/** The design's `vestNote` from a length and a cliff: "Vests 12 mo, 3-mo cliff" or "Vests 6 mo". */
function vestText(durationMs: number, cliffMs: number): string {
  return `Vests ${vestingDurationText(durationMs)}${cliffMs ? `, ${vestingDurationText(cliffMs).replace(" ", "-")} cliff` : ""}`;
}

/** One label and value row of a board card (`.kv`). */
function Row({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return <div><dt>{label}</dt><dd className="num">{children}</dd></div>;
}

/**
 * The Terms card's team row: the confirmed schedule ("Vests 12 mo, 3-mo
 * cliff"), or its explicit state — not confirmed, no allocation, loading,
 * failed with a retry, unavailable. A cancelled sale has no team unlocks.
 */
export function TeamVestingRow({ detail }: Readonly<{ detail: SocialPresaleDetail }>) {
  const queries = useAppQueryClient();
  const query = useQuery({ ...presaleDetailQuery(detail.presale.presale_id), enabled: false }, queries);
  const state = teamUnlockState(detail, teamUnlockRead(detail, query));
  if (state.kind === "cancelled") return null;
  const value = {
    configured: state.kind === "configured" ? vestText(state.durationMs, state.cliffMs) : "",
    pending: "Team schedule not confirmed yet",
    none: "No team token allocation",
    loading: "",
    error: "Couldn't load the team schedule.",
    unavailable: "No confirmed team schedule available.",
  }[state.kind];
  return (
    <div>
      <dt>Team vesting</dt>
      <dd className="num">
        <span aria-busy={state.kind === "loading" || undefined} aria-label={state.kind === "loading" ? "Loading team schedule" : undefined} role={state.kind === "configured" ? undefined : state.kind === "error" ? "alert" : "status"}>
          {state.kind === "loading" ? <SkeletonText>Vests 12 mo, 3-mo cliff</SkeletonText> : value}
        </span>
        {state.kind === "error" || state.kind === "unavailable" ? <Button className={cx("row-retry")} onClick={() => void query.refetch()} size="xs" variant="ghost">Try again</Button> : null}
      </dd>
    </div>
  );
}

/** Rules: what a wallet may commit, what happens over and under the target, withdrawals and the commit fee. */
function RulesCard({ detail }: Readonly<{ detail: SocialPresaleDetail }>) {
  const { presale: sale, terms } = detail;
  const perWallet = perWalletText(sale);
  return (
    <section aria-labelledby={`rules-${sale.presale_id.slice(-6)}`} className={cx("card sale-card")}>
      <div className={cx("sec-title")}><h2 id={`rules-${sale.presale_id.slice(-6)}`}>Rules</h2></div>
      <dl className={cx("kv")}>
        {terms?.eligibility.kind === "allowlisted" ? <Row label="Allowlist">{terms.eligibility.wallets.toLocaleString("en-US")} wallets, {perWallet}</Row>
          : sale.allowlisted ? <Row label="Allowlist">Any amount, {perWallet}</Row>
            : perWallet === "–" ? null : <Row label="Per wallet">{perWallet}</Row>}
        <FundingRuleRows detail={detail} />
        <Row label="Under target">Full refund</Row>
        <Row label="Withdrawals">Not allowed</Row>
        <Row label="Commit fee">None</Row>
      </dl>
    </section>
  );
}

function FundingRuleRows({ detail }: Readonly<{ detail: SocialPresaleDetail }>) {
  const { presale: sale, terms } = detail;
  const capped = terms?.hard_cap ?? sale.hard_cap ?? null;
  const capFrom = terms?.public_buy?.hard_cap_from_ms;
  const capStartsLater = capFrom != null && capFrom > sale.start_ms;
  const aboveTarget = isOversubscribed(sale);
  const overflowRule = "Tokens are split by share of commitments. Excess payment is refunded.";
  return (
    <>
      {capped === true && <Row label="Funding cap">{fundingCap(sale) ?? "Amount unavailable"}{capStartsLater ? <> from <DateStamp at={capFrom} label="funding cap start time" /></> : null}</Row>}
      {aboveTarget ? (
        <Row label="Above target">{sale.phase === "cancelled" ? "Full refund. No tokens are allocated." : overflowRule}</Row>
      ) : (
        <OverflowRuleRow capped={capped} capStartsLater={capStartsLater} overflowRule={overflowRule} />
      )}
    </>
  );
}

function OverflowRuleRow({ capped, capStartsLater, overflowRule }: Readonly<{ capped: boolean | null; capStartsLater: boolean; overflowRule: string }>) {
  if (capped === false) return <Row label="Can raise above target">{overflowRule}</Row>;
  if (capped === true && capStartsLater) return <Row label="Before the cap starts">Commitments can exceed the target. {overflowRule}</Row>;
  return null;
}

/**
 * The Sale board's terms: Tokenomics beside Where the money goes, Rules
 * beside Buyer vesting (R3-90's 2 × 2). Without terms (the projection
 * unreadable) the grid holds Rules and Buyer vesting.
 */
function TermsCards({ detail }: Readonly<{ detail: SocialPresaleDetail }>) {
  const { presale: sale, terms } = detail;
  const phone = usePhoneLayout();
  const allocations = terms ? <><TokenomicsCard sale={sale} terms={terms} showSupply={phone && sale.phase === "open"} /><MoneyCard sale={sale} terms={terms} /></> : null;
  return (
    <div className={cx("sale-grid")}>
      {phone ? null : allocations}
      <RulesCard detail={detail} />
      {sale.phase !== "trading" ? <BuyerVestingCard detail={detail} /> : null}
      {phone && allocations ? (
        <details className={cx("sale-disclosure")}>
          <DisclosureSummary className={cx("card")}><b>Tokenomics and allocations</b></DisclosureSummary>
          {allocations}
        </details>
      ) : null}
    </div>
  );
}

/** Tokenomics: the supply and how it splits (presale buyers, the locked pool, recipients, Blast). */
export function TokenomicsCard({ sale, terms, showSupply = false }: Readonly<{ sale: SocialPresaleDetail["presale"]; terms: NonNullable<SocialPresaleDetail["terms"]>; showSupply?: boolean }>) {
  const decimals = sale.sale_decimals;
  const tokens = (atoms: string) => {
    const count = atomsValue(atoms, decimals);
    return count === null ? "—" : `${qty(count)} ${sale.symbol}`;
  };
  return (
    <section aria-labelledby={`tok-${sale.presale_id.slice(-6)}`} className={cx("card sale-card")}>
      <div className={cx("sec-title")}>
        <h2 id={`tok-${sale.presale_id.slice(-6)}`}>Tokenomics</h2>
        {showSupply || sale.phase === "trading" ? <span>{supplyCaption(tokens(terms.supply.total), terms.burnable)}</span> : null}
      </div>
      <AllocationRows
        parts={[
          ["Presale buyers", terms.supply.participants.bps, tokens(terms.supply.participants.amount)],
          ["Liquidity pool", terms.supply.liquidity.bps, tokens(terms.supply.liquidity.amount), sale.phase === "cancelled" ? "Planned allocation" : "Locked forever"],
          ...terms.supply.recipients.map((recipient, index) => {
            const [label, note] = recipientLabel(recipient, index);
            return [label, recipient.bps, tokens(recipient.amount), note] as const;
          }),
          ["Blast", terms.supply.protocol.bps, tokens(terms.supply.protocol.amount)],
        ]}
      />
    </section>
  );
}

/** Where the money goes: the raise target's split (the pool, recipients, the Blast fee). */
function MoneyCard({ sale, terms }: Readonly<{ sale: SocialPresaleDetail["presale"]; terms: NonNullable<SocialPresaleDetail["terms"]> }>) {
  const cash = (bps: number) => saleShare(sale, sale.target_usd, sale.target_atoms, bps);
  return (
    <section aria-labelledby={`money-${sale.presale_id.slice(-6)}`} className={cx("card sale-card")}>
      <div className={cx("sec-title")}>
        <h2 id={`money-${sale.presale_id.slice(-6)}`}>Where the money goes</h2>
        <span>Of {saleShort(sale, sale.target_usd, sale.target_atoms)}</span>
      </div>
      <AllocationRows
        parts={[
          ["Liquidity pool", terms.raise.pool_bps, cash(terms.raise.pool_bps)],
          ...terms.raise.recipients.map((recipient, index) => {
            const [label] = recipientLabel(recipient, index);
            return [label, recipient.bps, cash(recipient.bps), recipient.vesting ? "Vests" : shortAddress(recipient.address)] as const;
          }),
          ["Blast fee", terms.raise.protocol.bps, cash(terms.raise.protocol.bps)],
        ]}
      />
    </section>
  );
}

/** Terms: the raise, the launch price with its FDV in the raise coin, the team's vesting and the pool's trading fee. */
export function SaleTermsCard({ detail }: Readonly<{ detail: SocialPresaleDetail }>) {
  const { presale: sale, terms } = detail;
  const launch = terms ? qp(quoteOf(sale), { usd: terms.launch_price_usd, quote: terms.launch_price_quote }) : null;
  // The FDV at the launch price, in the raise coin (redesign gap 12); without it the row names the price alone.
  const fdv = terms?.launch_fdv_quote ? `${qty(Number(terms.launch_fdv_quote))} ${sale.quote_symbol}` : null;
  // The migration pool's swap fee; an Aftermath sale, or a tier not indexed yet, has none and the row is omitted.
  const fee = terms?.trading_fee_ppm ?? null;
  return (
    <section aria-labelledby={`terms-${sale.presale_id.slice(-6)}`} className={cx("card sale-card")}>
      <div className={cx("sec-title")}><h2 id={`terms-${sale.presale_id.slice(-6)}`}>Terms</h2></div>
      <dl className={cx("kv")}>
        <Row label="Raise">{saleMoney(sale, sale.target_usd, sale.target_atoms)}</Row>
        {launch ? <Row label={sale.phase === "cancelled" ? "Planned launch price" : "Launch price"}>{launch}{fdv ? ` · FDV ${fdv}` : null}</Row> : null}
        <TeamVestingRow detail={detail} />
        {fee === null ? null : <Row label="Trading fee">{ppmPct(fee)}</Row>}
      </dl>
    </section>
  );
}

function aboutArtwork(sale: SocialPresaleDetail["presale"], cover: SocialSaleMetadata["cover"] | undefined, phone: boolean) {
  if (!cover) return null;
  if (sale.phase === "trading") return /^(https:|data:image\/)/.test(cover.url) ? <CoinCover cover={cover} /> : null;
  return phone ? <PresaleCover className={cx("sale-about-cover")} cover={cover} presaleId={sale.presale_id} /> : null;
}

/** About: the creator's tagline, artwork and links. */
function AboutCard({ detail }: Readonly<{ detail: SocialPresaleDetail }>) {
  const sale = detail.presale;
  const { metadata } = useSaleDetails(sale);
  const phone = usePhoneLayout();
  const artwork = aboutArtwork(sale, metadata?.cover, phone);
  const tagline = metadata?.tagline?.trim();
  const hasLinks = Boolean(metadata?.site || metadata?.x_handle || metadata?.telegram || metadata?.docs_url || metadata?.audit_url);
  if (!tagline && !hasLinks && !artwork) return null;
  return (
    <section aria-labelledby={`about-${sale.presale_id.slice(-6)}`} className={cx("card sale-card sale-about")}>
      <h2 id={`about-${sale.presale_id.slice(-6)}`}>About</h2>
      {tagline && <p className={cx("sale-tag")}>{tagline}</p>}
      {artwork}
      {hasLinks && <span className={cx("links")}><SaleLinks about metadata={metadata} sale={sale} /></span>}
    </section>
  );
}

/** The sale's coin as `openTrade` names it (R3-33's sheet opens with it chosen). */
function tradeCoinOf(sale: SocialPresaleDetail["presale"]) {
  return {
    coin_type: sale.sale_token,
    symbol: sale.symbol,
    name: sale.name,
    decimals: sale.sale_decimals,
    icon_url: sale.icon_url || null,
    usd_price: sale.price_usd,
    presale_id: sale.presale_id,
  };
}

export function SaleTradeButton({ sale, primary = false }: Readonly<{ sale: SocialPresaleDetail["presale"]; primary?: boolean }>) {
  const run = useShellActions();
  if (!tradesInApp(sale.venue)) return null;
  return <button className={cx("btn", primary ? "btn-primary" : "btn-quiet btn-block")} onClick={() => run("openTrade", encodeTradeAction({ side: "buy", coin: tradeCoinOf(sale) }))} type="button">Trade {sale.symbol}</button>;
}

/** The narrow-screen trade bar (the Mobile board): Sell beside Buy, each opening the shared trading sheet on its side. */
function TradingBar({ detail }: Readonly<{ detail: SocialPresaleDetail }>) {
  const run = useShellActions();
  const sale = detail.presale;
  if (!tradesInApp(sale.venue)) return null;
  const open = (side: "buy" | "sell") => run("openTrade", encodeTradeAction({ side, coin: tradeCoinOf(sale) }));
  return <div className={cx("m-commitbar onSale trading-entry")}>
    <Button onClick={() => open("sell")} size="lg">Sell</Button>
    <Button onClick={() => open("buy")} size="lg" variant="primary">Buy {sale.symbol.replace(/^\$/, "")}</Button>
  </div>;
}

/**
 * The phone and tablet bar: funding and Commit, upcoming notifications, or trading actions.
 */
function CommitBar({ detail, now, commit }: Readonly<{ detail: SocialPresaleDetail; now: number; commit?: SaleCommit }>) {
  const sale = detail.presale;
  if (sale.phase === "trading") return <TradingBar detail={detail} />;
  return <LifecycleBar commit={commit} detail={detail} now={now} />;
}

/** The action follows the lifecycle; reaching a target alone never closes this flow. */
function LifecycleBar({ detail, now, commit }: Readonly<{ detail: SocialPresaleDetail; now: number; commit?: SaleCommit }>) {
  const sale = detail.presale;
  const funding = fundingState(detail, now);
  const gate = useSignInGate();
  const store = useViewerStateStore();
  const target = { kind: "presale", presale_id: sale.presale_id } as const;
  const on = useViewerFollow(target) === true;
  if (funding.open) {
    return (
      <div className={cx("m-commitbar onSale")}>
        <span className={cx("t")}>
          <b className={cx("num")}>{funding.label}</b>
          <span>Closes in <TimeLeft now={now} to={sale.end_ms} /></span>
        </span>
        <BlastButton commit={commit} gate={gate} held={heldTargetOfSale(sale)} presaleId={sale.presale_id} label={`Commit ${sale.quote_symbol}`} />
      </div>
    );
  }
  if (sale.phase !== "pending") return null;
  return (
    <div className={cx("m-commitbar onSale")}>
      <span className={cx("t")}>
        {opensAt(sale.start_ms) === null ? (
          <>
            <b>{NOT_OPEN_YET}</b>
            <span>No date set</span>
          </>
        ) : (
          <>
            <b className={cx("num")}>Opens in <TimeLeft now={now} to={sale.start_ms} /></b>
            <DateStamp at={sale.start_ms} label="presale opening time" />
          </>
        )}
      </span>
      <button
        aria-pressed={on}
        className={cx("btn btn-primary notify-btn", on && "on")}
        onClick={async (event: MouseEvent) => {
          if (!gate.signedIn) {
            gate.openSignIn(event);
            if (!event.defaultPrevented) window.location.assign(gate.signInHref);
            return;
          }
          await store?.setFollowing(target, !on);
        }}
        type="button"
      >
        <BellIcon />
        {on ? "Notifying" : "Notify me"}
      </button>
    </div>
  );
}

/**
 * The commit action. A visitor signs in first (the design's gate). A
 * signed-in viewer gets the commit dialog once one is registered (`commit`);
 * until the presale contract is live there is none, and the button stays
 * disabled with a plain reason, so nothing pretends to commit.
 *
 * Under the commit host it is also a hold-to-blast button (R3-13, `held`): a
 * tap opens the dialog as before; a hold charges $50 → $1,000 within the
 * wallet's USDC and commits on release through the one commit module.
 */
export function BlastButton({
  commit,
  gate,
  presaleId,
  label,
  large,
  describedBy,
  held: heldTarget,
}: Readonly<{
  commit?: SaleCommit;
  gate: ReturnType<typeof useSignInGate>;
  presaleId: string;
  label: string;
  large?: boolean;
  describedBy?: string;
  /** The sale, for hold to blast (`heldTargetOfSale`); without it the button only taps. */
  held?: HeldBlastTarget;
}>) {
  const held = useHeldBlast(gate.signedIn && !gate.sessionPending && commit && heldTarget ? heldTarget : null);
  if (!gate.signedIn && !commit && !gate.sessionPending) {
    return (
      <Link className={cx("btn btn-primary", large && "btn-lg btn-block")} href={gate.signInHref} onClick={gate.openSignIn}>
        {large ? "Sign in to commit" : label}
      </Link>
    );
  }
  return (
    <button
      aria-busy={held.blasting || undefined}
      aria-describedby={commit ? undefined : describedBy}
      aria-label={held.ariaLabel}
      className={clsx(cx("btn btn-primary", large && "btn-lg btn-block"), held.className)}
      disabled={!commit}
      onClick={() => commit?.open(presaleId)}
      style={held.style}
      type="button"
      {...held.holdProps}
    >
      {held.label(label)}
    </button>
  );
}

/** The Coin board's range switch: the price windows the read serves, named as the board names them. */
const COIN_WINDOWS = [["1h", "1H"], ["24h", "1D"], ["7d", "1W"], ["30d", "1M"], ["launch", "All"]] as const;

/** The coin's posts: the entries with an authored why. */
function CoinPosts({ detail, nowMs }: Readonly<{ detail: SocialPresaleDetail; nowMs: number }>) {
  const query = useInfiniteQuery(discussionQuery(detail.presale.presale_id), useAppQueryClient());
  if (query.isPending) return <p aria-busy="true" aria-label="Loading posts" className={cx("plain")} role="status"><SkeletonText>Reading the latest posts</SkeletonText></p>;
  if (query.isError) return <EmptyState action={<Button onClick={() => void query.refetch()} size="sm">Try again</Button>} role="alert" title="Posts couldn’t load" />;
  return <ActivityRows detail={detail} empty="No posts yet" items={query.data.pages.flatMap((page) => page.items)} now={nowMs} />;
}

function CoinActivity({ detail, holders, nowMs }: Readonly<{ detail: SocialPresaleDetail; holders: ReactNode; nowMs: number }>) {
  return <CoinTradingActivity
    key={detail.presale.presale_id}
    trades={<SaleTrades sale={detail.presale} />}
    holders={holders}
    posts={<CoinPosts detail={detail} nowMs={nowMs} />}
    lazy
  />;
}

/** The team's schedule once trading: in words, with its first unlock and its end. */
function TradingVesting({ detail }: Readonly<{ detail: SocialPresaleDetail }>) {
  const vesting = detail.team_vesting ?? detail.vesting;
  if (!vesting) return null;
  return <section className={cx("card sale-card trading-vesting")}>
    <div className={cx("sec-title")}><h2>{detail.team_vesting ? "Team vesting" : "Vesting window"}</h2></div>
    <p className={cx("plain")}>{detail.team_vesting ? vestPlain(vesting.end_ms - vesting.start_ms, vesting.cliff_end_ms - vesting.start_ms) : "Recipients may have different vesting schedules."}</p>
    <dl className={cx("kv")}><Row label={detail.team_vesting ? "First unlock" : "Earliest unlock"}><DateStamp at={vesting.cliff_end_ms} label="first unlock time" /></Row><Row label={detail.team_vesting ? "Fully vested" : "Latest vesting end"}><DateStamp at={vesting.end_ms} label="vesting end time" /></Row></dl>
  </section>;
}

/**
 * The Coin board's main column: the market card (price, range, chart and
 * tiles) and Activity (trades, holders, posts), then the team's and buyers'
 * vesting and, folded away, the presale's own history.
 */
function TradingSale({ detail, claims, children, nowMs }: Readonly<{ detail: SocialPresaleDetail; claims?: ReactNode; children: ReactNode; nowMs: number }>) {
  const phone = usePhoneLayout();
  const claimCard = claims ? <div className={cx("trading-mobile-claims")}>{claims}</div> : null;
  return <>
    {phone ? claimCard : null}
    <SaleTradeFeed key={detail.presale.presale_id} sale={detail.presale}>
      <SaleMarket sale={detail.presale} terms={detail.terms} nowMs={nowMs} windows={COIN_WINDOWS} activity={(holders) => <CoinActivity detail={detail} holders={holders} nowMs={nowMs} />}>
        {phone ? null : claimCard}
      </SaleMarket>
    </SaleTradeFeed>
    <AboutCard detail={detail} />
    <div className={cx("sale-pills")}><TrustBadges lpLocked sale={detail.presale} /></div>
    <TradingVesting detail={detail} />
    <BuyerVestingCard detail={detail} />
    <details className={cx("presale-history")} id="presaleHistory">
      <DisclosureSummary className={cx("card")}><b>Presale history</b></DisclosureSummary>
      {children}
    </details>
  </>;
}

function useLinkedSaleTab(): TabKey {
  const activityLink = useSearchParams()?.get("tab") === "activity";
  useEffect(() => {
    if (!activityLink) return;
    const history = document.getElementById("presaleHistory");
    if (history instanceof HTMLDetailsElement) history.open = true;
    document.getElementById("saleTabs")?.scrollIntoView({ block: "start" });
  }, [activityLink]);
  return activityLink ? "activity" : "backers";
}

function SaleAnalytics({ detail, viewerEntry, me, now }: Readonly<{
  detail: SocialPresaleDetail;
  viewerEntry: SocialPresaleViewerEntry | null;
  me: Readonly<{ avatar_url: string | null }> | null;
  now: number;
}>) {
  const phone = usePhoneLayout();
  const viewer = useSocialViewer();
  const [overlays, setOverlays] = useState<ChartOverlays>({ mine: true, following: true, big: true, thesis: false });
  const marks = useMemo<ChartMark[]>(
    () => saleChartMarks({ detail, viewerEntry, overlays, me, viewerCallsign: viewer.callsign }),
    [detail, viewerEntry, overlays, me, viewer.callsign],
  );
  const sale = detail.presale;
  const hasMomentum = sale.phase === "open" && detail.backers.top.length > 0;
  const hasLaunchPrice = sale.phase === "trading" && sale.price_usd !== null &&
    qp(quoteOf(sale), { usd: sale.presale_price_usd, quote: sale.presale_price_quote }) !== null;
  const hasRaise = detail.raise.points.length > 0;
  if (!hasLaunchPrice && !hasMomentum && !hasRaise) return null;
  const charts = <>
    <SinceLaunch detail={detail} />
    {hasRaise ? (
      <section className={cx("card sale-card")}>
        <div className={cx("sec-title")}>
          <h2>Raise</h2>
          <div aria-label="Show on chart" className={cx("overlays")} role="group">
            {([["mine", "My commits"], ["following", "Following"], ["big", "Big commits"], ["thesis", "Thesis"]] as const).map(([key, label]) => (
              <button
                aria-pressed={overlays[key]}
                className={cx("ovl", overlays[key] && "on")}
                key={key}
                onClick={() => setOverlays((current) => ({ ...current, [key]: !current[key] }))}
                onFocus={(event) => {
                  if (event.currentTarget.matches(":focus-visible")) event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
                }}
                type="button"
              >
                <CheckIcon strong />
                {label}
              </button>
            ))}
          </div>
        </div>
        <RaiseChart detail={detail} marks={marks} nowMs={now} overlays={overlays} />
      </section>
    ) : null}
    {hasMomentum ? <Momentum detail={detail} /> : null}
  </>;
  return phone ? (
    <details className={cx("sale-disclosure")}>
      <DisclosureSummary className={cx("card")}><b>{hasMomentum ? "Raise and momentum" : "Raise history"}</b></DisclosureSummary>
      {charts}
    </details>
  ) : charts;
}

/** Everything the sale page shows in its main column (FEATURE-MAP §10.1–§10.3), as the Sale board (live) or the Coin board (trading) draws it. */
export function SaleView({
  detail,
  viewerEntry,
  nowMs,
  watch,
  commit,
  me,
  tradingClaims,
  refund,
  position,
}: Readonly<{
  tradingClaims?: ReactNode;
  refund?: ReactNode;
  /** The viewer's position read state; it sits in the body so the page keeps the shell's two rows (head, then body beside the column). */
  position?: ReactNode;
  detail: SocialPresaleDetail;
  viewerEntry: SocialPresaleViewerEntry | null;
  nowMs: number;
  watch?: SaleWatch;
  commit?: SaleCommit;
  me?: Readonly<{ avatar_url: string | null }> | null;
}>) {
  const [nowState, setNow] = useState(nowMs);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const now = nowState;
  const sale = detail.presale;
  const trading = sale.phase === "trading";
  const initialTab = useLinkedSaleTab();
  const [tab, setTab] = useState<TabKey>(initialTab);
  const tabBody = useRef<HTMLDivElement>(null);
  useFeedbackReveal(tab, tabBody);
  const [filters, setFilters] = useState({ following: false, big: false });
  useEffect(() => {
    const show = () => {
      setTab("backers");
      setFilters({ following: true, big: false });
      const history = document.getElementById("presaleHistory");
      if (history instanceof HTMLDetailsElement) history.open = true;
      document.getElementById("saleTabs")?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    window.addEventListener(SHOW_FOLLOWING_EVENT, show);
    return () => window.removeEventListener(SHOW_FOLLOWING_EVENT, show);
  }, []);
  const seeAll = () => window.dispatchEvent(new Event(SHOW_FOLLOWING_EVENT));
  const hasBackers = detail.backers.top.length > 0;
  const record = (<>
      <SaleAnalytics detail={detail} me={me ?? null} now={now} viewerEntry={viewerEntry} />
      {hasBackers ? (
        <section className={cx("card sale-card")} id="saleTabs">
          <div className={cx("sec-title")}>
            <Segmented
              id="saleTabList"
              label="Sale details"
              onChange={setTab}
              options={[["backers", "Backers"], ["thesis", "Thesis"], ["activity", "Activity"]] as const}
              size="sm"
              tabs
              value={tab}
            />
          </div>
          <div aria-labelledby="saleTabList" className={cx("tabBody")} id="tabBody" ref={tabBody} role="tabpanel">
            {tab === "thesis" ? <Theses detail={detail} />
              : tab === "activity" ? <ActivityRows detail={detail} now={now} />
                : (
                  <BackersTable
                    detail={detail}
                    entry={viewerEntry}
                    followingOnly={filters.following}
                    now={now}
                    onFilter={(key) => setFilters((current) => ({ ...current, [key]: !current[key] }))}
                    overOneK={filters.big}
                  />
                )}
          </div>
        </section>
      ) : null}
  </>);
  // The Sale board's column: the raise, the state line, the 2 × 2 terms, Terms and About.
  const board = (<>
      {refund ? <div className={cx("trading-mobile-claims")}>{refund}</div> : null}
      <RaiseCard detail={detail} now={now} />
      {trading ? null : <SaleNotice detail={detail} now={now} />}
      <TermsCards detail={detail} />
      <SaleTermsCard detail={detail} />
      {trading ? null : <AboutCard detail={detail} />}
      <FriendsCard detail={detail} entry={viewerEntry} narrow onSeeAll={seeAll} />
      {record}
  </>);
  return (
    <div className={cx("sale-page", trading && "coin-page")} data-sale-page="" data-shell-aside="wide" onFocusCapture={(event) => {
      const bar = event.currentTarget.querySelector<HTMLElement>(".m-commitbar");
      if (!bar || bar.contains(event.target)) return;
      const boundary = bar.getBoundingClientRect();
      const focused = event.target.getBoundingClientRect();
      if (boundary.height > 0 && focused.bottom > boundary.top && focused.top < boundary.bottom) event.target.scrollIntoView({ block: "center", behavior: "instant" });
    }}>
      <div className={cx("sale-head")}>
        <BackBar />
        {trading ? <CoinHead detail={detail} watch={watch} /> : <SaleHead detail={detail} now={now} watch={watch} />}
      </div>
      <div className={cx("sale-body")} data-sale-content="">
        {position}
        {trading ? <TradingSale detail={detail} claims={tradingClaims} nowMs={now}>{board}</TradingSale> : board}
        {detail.presale.phase === "pending" ? <SaleAccessCard detail={detail} /> : null}
        <CommitBar commit={commit} detail={detail} now={now} />
      </div>
    </div>
  );
}
