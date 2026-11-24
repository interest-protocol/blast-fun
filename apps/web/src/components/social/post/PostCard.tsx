"use client";

import clsx from "clsx";
import { IntentLink as Link } from "#web/components/blast-ui/NavigationLink.tsx";
import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Button } from "#web/components/blast-ui/Button.tsx";
import { DateStamp } from "#web/components/blast-ui/DateStamp.tsx";
import { CoinVerifiedMark } from "#web/components/blast-ui/Icons.tsx";
import { useShellActions } from "#web/components/blast-ui/shell-actions.tsx";
import { useHydrated } from "#web/components/ui-libraries/use-hydrated.tsx";
import type { FeedItem, FeedItemWhy } from "@blast/core/web/contracts/items.ts";

import { encodeTradeAction } from "../coins/swap-model";
import { fetchTradeCoins } from "../coins/swap-client";
import { heldTargetOfItem, useHeldBlast } from "../commit/use-held-blast";
import { ActTicketIcon, BoltIcon, BuyIcon, DownloadIcon, PeopleIcon, SellIcon, TargetIcon, TrendIcon, VerifiedBadge } from "../feed-ui/icons";
import { useFeedOverlays } from "../feed-ui/shell-bridge";
import { presaleHref } from "../feed-ui/shell-bridge-model";
import { useSocialViewer } from "../SignInGate";
import { useBoundaryClock } from "../use-boundary-clock";
import { CallCard } from "./CallCard";
import { useCoinMoves } from "./coin-moves";
import { Facepile } from "./Facepile";
import { ago, fullDate } from "./post-format";
import { canAddWhy, phoneThroughLine, postMenuItems, postView, type PostBody, type PostChip, type PostCta, type PostView } from "./post-model";
import styles from "./PostCard.module.css";
import { PostFollow } from "./PostFollow";
import { OwnProfileActivity } from "./own-profile-activity";
import { Avatar, PresaleMark, WalletAvatar } from "./PostMedia";
import { PostMenu } from "./PostMenu";
import { RocketButton } from "./RocketButton";
import { WhyComposer } from "./WhyComposer";

const CHIPS: Readonly<Record<PostChip, { label: string; icon: ReactNode }>> = {
  blast: { label: "Blast", icon: <ActTicketIcon /> },
  claim: { label: "Claim", icon: <DownloadIcon /> },
  call: { label: "Call", icon: <TargetIcon /> },
  buy: { label: "Buy", icon: <BuyIcon /> },
  sell: { label: "Sell", icon: <SellIcon /> },
};

/** A presale chip (`.tchip`): its mark and symbol, opening the sale (its page until the sale dialog exists). */
function PresaleChip({ presale, detail = false }: Readonly<{ presale: NonNullable<FeedItem["presale"]>; detail?: boolean }>) {
  const overlays = useFeedOverlays();
  return (
    <Link
      className={styles.tchip}
      href={presaleHref(presale.presale_id)}
      onClick={(event) => {
        if (!overlays.mounted.sale) return;
        event.preventDefault();
        overlays.openSale(presale.presale_id);
      }}

    >
      <PresaleMark coinType={presale.coin_type} presaleId={presale.presale_id} size={20} src={presale.icon_url} />
      {detail ? <span className="ticker">{presale.symbol}</span> : presale.symbol}
      {presale.verified_team ? <CoinVerifiedMark size="sm" /> : null}
    </Link>
  );
}

function NewsBody({ body }: Readonly<{ body: Extract<PostBody, { kind: "news" }> }>) {
  const { headline, sub, closesAtMs } = body;
  const closing = closesAtMs === undefined
    ? null
    : <>Closes <DateStamp at={closesAtMs} label="presale closing time" />.</>;
  return (
    <>
      <p className={styles.headline}>{headline}</p>
      {sub || closing ? <p className={styles.sub}>{sub}{sub && closing ? " " : null}{closing}</p> : null}
    </>
  );
}

function Body({ body, detail = false }: Readonly<{ body: PostBody; detail?: boolean }>) {
  if (body.kind === "news") return <NewsBody body={body} />;
  const chip = CHIPS[body.chip];
  return (
    <div className={styles.actLine}>
      <div className={styles.actSummary}>
        <span className={styles.act}>
          {chip.icon}
          {chip.label}
        </span>
        {body.amount ? <span className={styles.actAmt} role="region" aria-label="Transaction amount" tabIndex={0}>{body.amount}</span> : null}
      </div>
      {body.presale ? <PresaleChip detail={detail} presale={body.presale} /> : null}
      {body.tail ? (
        <span className={styles.actAt}>
          {body.tail}
          {body.now ? (
            <>
              {" · now "}
              <span className={clsx(styles.actNow, body.now.up ? styles.up : styles.down)}>{body.now.text}</span>
            </>
          ) : null}
        </span>
      ) : null}
      {body.tag === "big-buy" ? <span className={styles.tag}>Big buy</span> : null}
    </div>
  );
}

/**
 * The call to action (§3.6): "Blast" opens the commit dialog, "View
 * presale" the sale dialog (their pages until either is mounted).
 *
 * "Blast" is a **hold-to-blast** target (OA-23's Feel layer,
 * `FEEL-LAYER.md` §2): a press arms at 220 ms, the amount climbs
 * $50 → $100 → $500 → $1,000 every 650 ms but never past the viewer's USDC,
 * a 40 px drag, Escape or a `pointercancel` calls it off, and the release
 * commits that amount with no dialog while a pink ball flies into the sale's
 * raise bar. A quick tap is unchanged: it opens the dialog. It is
 * `useHeldBlast` (R3-13): the Feel layer's charge, and the one commit module's
 * quote, refusals and write, crediting this post as the source.
 *
 * The ball lands on whatever bar the page already draws for this sale
 * (`[data-bar="<presale id>"]`: the right column's "Fastest filling" rows,
 * Today on Blast). Without one there is no flight and the commit goes at
 * once, which is the reference's own fallback.
 *
 * A sale scheduled to open later charges from its start (#588): the card's
 * clock (`nowMs`) moves on once the start passes (`useBoundaryClock`).
 */
function Cta({ cta, item, nowMs }: Readonly<{ cta: Exclude<PostCta, { kind: "buy" }>; item: FeedItem; nowMs: number }>) {
  const overlays = useFeedOverlays();
  const viewer = useSocialViewer();
  const presaleId = item.presale?.presale_id ?? "";
  const mounted = cta.kind === "commit" ? overlays.mounted.commit : overlays.mounted.sale;
  const clock = useBoundaryClock(item.presale?.start_ms, nowMs);
  // Only "Blast" charges; its commit is the commit host's, crediting this post.
  const target = useMemo(
    () => (cta.kind === "commit" && mounted ? heldTargetOfItem(item, viewer.callsign, clock) : null),
    [clock, cta.kind, item, mounted, viewer.callsign],
  );
  const held = useHeldBlast(target);
  if (!mounted) {
    return (
      <Link className={clsx("btn btn-line", styles.cta)} href={presaleHref(presaleId)}>
        {cta.label}
      </Link>
    );
  }
  // The charge's level is a custom property: it reaches the button's glow through this box, which draws nothing itself.
  return (
    <span className={styles.charge} style={held.style}>
      <Button
        aria-busy={held.blasting || undefined}
        aria-haspopup="dialog"
        aria-label={held.ariaLabel}
        className={clsx(styles.cta, held.className)}
        onClick={() => (cta.kind === "commit" ? overlays.openCommit(item) : overlays.openSale(presaleId))}
        {...held.holdProps}
      >
        {held.label(cta.label)}
      </Button>
    </span>
  );
}

/** The sale's coin as the trade sheet names it (`GET /api/social/trades/coins`, public), or null when it is not listed or the read failed. */
async function tradeCoinOf(presale: NonNullable<FeedItem["presale"]>) {
  const page = await fetchTradeCoins({ q: presale.symbol }).catch(() => null);
  return page?.coins.find((coin) => coin.presale_id === presale.presale_id) ?? null;
}

/**
 * R3-83: a buy's "Buy too" (oa41's `cbuy`) opens the swap, USDC for the
 * coin, as a sale page's Buy does (`openTrade`, R3-34) with the coin chosen;
 * a visitor gets the sign-in sheet. Without a trade sheet (a page outside the
 * shell) or a listed coin, it opens the coin's sale.
 */
function BuyCta({ cta }: Readonly<{ cta: Extract<PostCta, { kind: "buy" }> }>) {
  const overlays = useFeedOverlays();
  const run = useShellActions();
  const [busy, setBusy] = useState(false);
  const buy = async () => {
    if (!overlays.signedIn) {
      if (!overlays.openSignIn()) window.location.assign(overlays.signInHref);
      return;
    }
    setBusy(true);
    const coin = await tradeCoinOf(cta.presale).finally(() => setBusy(false));
    if (coin !== null && run("openTrade", encodeTradeAction({ side: "buy", coin }))) return;
    overlays.openSale(cta.presale.presale_id);
  };
  return (
    <Button aria-busy={busy || undefined} aria-haspopup="dialog" className={styles.cta} onClick={() => void buy()}>
      {cta.label}
    </Button>
  );
}

function Lead({ post }: Readonly<{ post: PostView }>) {
  const lead = post.lead;
  if (lead.kind === "account") {
    return (
      <Link aria-label={lead.name} className={styles.lead} href={lead.path}>
        <Avatar callsign={lead.callsign} src={lead.avatarUrl} />
      </Link>
    );
  }
  if (lead.kind === "presale") {
    return (
      <Link aria-label={lead.presale.name} className={clsx(styles.lead, styles.leadMark)} href={presaleHref(lead.presale.presale_id)}>
        <PresaleMark badge coinType={lead.presale.coin_type} presaleId={lead.presale.presale_id} src={lead.presale.icon_url} />
      </Link>
    );
  }
  return (
    <span className={styles.lead}>
      <WalletAvatar hue={lead.hue} />
    </span>
  );
}

/** The time: a link to the transaction on the explorer, with the full date as its title. */
function Time({ post, nowMs }: Readonly<{ post: PostView; nowMs: number }>) {
  const hydrated = useHydrated();
  const title = hydrated ? fullDate(post.occurredAtMs) : `${fullDate(post.occurredAtMs, "UTC")} UTC`;
  const text = ago(post.occurredAtMs, nowMs);
  const dateTime = new Date(post.occurredAtMs).toISOString();
  if (!post.txUrl) {
    return (
      <time dateTime={dateTime} title={title}>
        {text}
      </time>
    );
  }
  return (
    <a href={post.txUrl} rel="noopener noreferrer" target="_blank" title={title}>
      <time dateTime={dateTime}>{text}</time>
      <span className={styles.srOnly}> (transaction on the explorer, opens in a new tab)</span>
    </a>
  );
}



function Header({ post, nowMs, labelId }: Readonly<{ post: PostView; nowMs: number; labelId: string }>) {
  const ownProfileActivity = useContext(OwnProfileActivity);
  const header = post.header;
  if (header.kind === "account") {
    return (
      <>
        <Link className={styles.name} href={header.path} id={labelId}>
          <span className="nm">{header.name}</span>
          {header.verified ? <VerifiedBadge className={styles.verified} /> : null}
        </Link>
        {/* R3-07: the handle ellipsises on its own (`flex-shrink: 9999`), so a long one never pushes the time out. */}
        <span className={clsx(styles.meta, styles.metaH)}>@{header.callsign}</span>
        <span className={styles.meta}>
          {"· "}
          <Time nowMs={nowMs} post={post} />
        </span>
        {header.own && !ownProfileActivity ? <span className={styles.you}>You</span> : null}
      </>
    );
  }
  if (header.kind === "presale") {
    return (
      <>
        <Link className={styles.name} href={presaleHref(header.presale.presale_id)} id={labelId}>
          {header.presale.verified_team ? (
            <>
              <span className="nm">{header.presale.name}</span>
              <CoinVerifiedMark size="sm" />
            </>
          ) : (
            header.presale.name
          )}
        </Link>
        <span className={styles.meta}>
          Presale · <Time nowMs={nowMs} post={post} />
        </span>
      </>
    );
  }
  return (
    <>
      <span className={clsx(styles.name, styles.addr)} id={labelId}>
        {header.short}
      </span>
      <span className={styles.meta}>
        · <Time nowMs={nowMs} post={post} />
      </span>
    </>
  );
}

/**
 * The item's why as this card shows it: the item's, until the viewer posts
 * or deletes one here (shown at once, without a reload). A newer item from
 * the list (another why id) replaces the local one.
 */
function useLocalWhy(item: FeedItem): Readonly<{ why: FeedItemWhy | null; set: (why: FeedItemWhy | null) => void }> {
  const from = item.why?.why_id ?? null;
  const [local, setLocal] = useState<Readonly<{ from: string | null; why: FeedItemWhy | null }>>({ from, why: item.why });
  const set = (why: FeedItemWhy | null) => setLocal({ from, why });
  if (local.from !== from) {
    // State set while rendering (React's pattern for props that change): the list's newer item wins.
    setLocal({ from, why: item.why });
    return { why: item.why, set };
  }
  return { why: local.why, set };
}

function PostContext({ post }: Readonly<{ post: PostView }>) {
  return (
    post.context ? (
      <span className={styles.context}>
        <BoltIcon />
        Big blast
      </span>
    ) : post.whyNow ? (
      <span className={styles.context}>
        <TrendIcon />
        {post.whyNow}
      </span>
    ) : null
  );
}

/**
 * The canonical post card (FEATURE-MAP §3, `article.post`) for any feed item:
 * named commits and claims, anonymous big commits, calls (OA-9) and the
 * presale's own posts, with the rocket (OA-5), Follow, the More menu and the
 * call to action. Unknown kinds render nothing. All user text (names, the
 * why) is plain text, never linked.
 *
 * `nowMs` is the clock relative times count from: the server's on the first
 * render, so server and browser agree, then the list's 30 s tick.
 */
export function PostCard({ item, nowMs, variant = "feed" }: Readonly<{ item: FeedItem; nowMs: number; variant?: "feed" | "detail" }>) {
  const viewer = useSocialViewer();
  const why = useLocalWhy(item);
  const shown = why.why === item.why ? item : { ...item, why: why.why };
  const whyText = useRef<HTMLParagraphElement>(null);
  // A why just posted here takes focus once it renders, so a screen reader reads it.
  const focusWhy = useRef(false);
  useEffect(() => {
    if (!focusWhy.current || !whyText.current) return;
    focusWhy.current = false;
    whyText.current.focus({ preventScroll: true });
  });
  const moves = useCoinMoves(item.kind === "trade_buy");
  const post = postView(shown, viewer.callsign, moves);
  if (!post) return null;
  const labelId = `post-${post.postId}-head`;
  return (
    <article aria-labelledby={labelId} className={clsx("card", styles.post, variant === "detail" && styles.detail)} data-entry-id={post.entryId} data-kind={item.kind} data-surface="">
      <Lead post={post} />
      <div className={styles.pbody}>
        {item.pinned ? <span className={styles.context}>Pinned by Blast</span> : null}
        <PostContext post={post} />
        <div className={styles.prow}>
          <Header labelId={labelId} nowMs={nowMs} post={post} />
          <span className={styles.end}>
            {post.followCallsign ? <PostFollow callsign={post.followCallsign} /> : null}
            <PostMenu
              items={postMenuItems(post)}
              profilePath={post.header.kind === "account" ? post.header.path : undefined}
              onWhyDeleted={() => why.set(null)}
              postId={post.postId}
              txUrl={post.txUrl}
              whyId={post.whyId}
            />
          </span>
        </div>
        <Body body={post.body} detail={variant === "detail"} />
        {post.backers ? <Facepile list={post.backers.list} participants={post.backers.participants} presaleId={post.backers.presaleId} /> : null}
        {post.why ? (
          <p className={styles.why} ref={whyText} tabIndex={shown === item ? undefined : -1}>
            {post.why}
          </p>
        ) : canAddWhy(shown, viewer.callsign, nowMs) ? (
          <WhyComposer
            entryId={post.entryId}
            kind={item.kind}
            onPosted={(created) => {
              focusWhy.current = true;
              why.set(created);
            }}
          />
        ) : null}
        {post.call ? <CallCard call={post.call} iconOnlyVenue={variant === "detail"} /> : null}
        <PostFooter item={item} nowMs={nowMs} post={post} />
      </div>
    </article>
  );
}

function PostFooter({ item, post, nowMs }: Readonly<{ item: FeedItem; post: PostView; nowMs: number }>) {
  return (
    <>
      <div className={styles.pfoot}>
        <div className={styles.footL}>
          <RocketButton count={post.rockets} entryId={post.entryId} />
          {post.through ? (
            <span className={styles.thru} title="Through this post">
              <PeopleIcon />
              <b className={styles.num}>{post.through.people.toLocaleString("en-US")}</b> {post.throughWord}
              <span className={styles.thruAmt}>
                {" · "}
                <span className={styles.num}>{post.through.volume}</span>
              </span>
            </span>
          ) : null}
        </div>
        {post.cta?.kind === "buy" ? <BuyCta cta={post.cta} /> : post.cta ? <Cta cta={post.cta} item={item} nowMs={nowMs} /> : null}
      </div>
      {post.through ? (
        <span className={styles.mThru}>
          <PeopleIcon />
          {phoneThroughLine(post)}
        </span>
      ) : null}
    </>
  );
}
