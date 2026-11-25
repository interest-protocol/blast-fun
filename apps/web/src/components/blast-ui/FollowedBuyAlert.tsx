"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import type { SocialBuyAlert } from "@blast/core/modules/social/contracts/buy-alerts.ts";

import { Avatar } from "./Avatar";
import { IconButton } from "./Button";
import { CoinMark } from "./CoinMark";
import { CloseIcon } from "./Icons";
import { ALERT_LIFE_MS, SWIPE_DISTANCE_PX, SWIPE_VELOCITY, buyAlertText } from "./followed-buy-alert-model";
import styles from "./FollowedBuyAlert.module.css";

/** A press that moves less than this is a click, not a drag. */
const DRAG_SLOP_PX = 4;
/** The exit's length in CSS; a fallback ends it when no transition runs. */
const EXIT_MS = 160;

/**
 * Counts the card's life down only while nobody is looking closer: hover,
 * focus inside, a drag or a hidden tab each pause it, and the count resumes
 * where it stopped.
 */
function useLife(paused: boolean, onExpire: () => void): void {
  const remaining = useRef(ALERT_LIFE_MS);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const update = () => setHidden(document.visibilityState === "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  useEffect(() => {
    if (paused || hidden) return undefined;
    const started = Date.now();
    const timer = window.setTimeout(onExpire, remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - started));
    };
  }, [paused, hidden, onExpire]);
}

type Drag = { id: number; startY: number; startAt: number; dy: number; captured: boolean };

/**
 * One followed buy, at the top centre of the page: "Maya bought $120 of
 * ORBIT · $45K cap". The name opens the profile, the coin its page. Silent;
 * the host's polite status region announces it. It slides down on arrival, leaves faster than
 * it came, and goes with a swipe up, the close button, or after
 * `ALERT_LIFE_MS`. With reduced motion it only fades.
 */
export function FollowedBuyAlert({ alert, coinHref, onClose }: Readonly<{ alert: SocialBuyAlert; coinHref: string; onClose: () => void }>) {
  const card = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [mounted, setMounted] = useState(false);
  const [leaving, setLeaving] = useState<"up" | "fade" | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const text = buyAlertText(alert);

  useEffect(() => {
    // One frame at the start state, so the arrival transitions (no keyframes: a newer card can retarget it).
    const frame = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  const leave = useCallback((how: "up" | "fade") => setLeaving((current) => current ?? how), []);
  useEffect(() => {
    if (!leaving) return undefined;
    const timer = window.setTimeout(onClose, EXIT_MS + 40);
    return () => window.clearTimeout(timer);
  }, [leaving, onClose]);

  const expire = useCallback(() => leave("fade"), [leave]);
  useLife(hovered || focused || dragging || leaving !== null, expire);

  const move = (y: number) => {
    if (card.current) card.current.style.transform = y === 0 ? "" : `translateY(${y}px)`;
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // One pointer drives the drag; a second finger is ignored.
    if (drag.current || leaving || (event.pointerType === "mouse" && event.button !== 0)) return;
    drag.current = { id: event.pointerId, startY: event.clientY, startAt: event.timeStamp, dy: 0, captured: false };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    const raw = event.clientY - current.startY;
    if (!current.captured) {
      if (Math.abs(raw) < DRAG_SLOP_PX) return;
      // Captured only once it is a drag, so a plain press still clicks the links.
      event.currentTarget.setPointerCapture(event.pointerId);
      current.captured = true;
      setDragging(true);
    }
    // Up follows the finger; down meets growing friction.
    current.dy = raw < 0 ? raw : Math.sqrt(raw) * 2;
    move(current.dy);
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    drag.current = null;
    if (!current.captured) return;
    setDragging(false);
    const velocity = -current.dy / Math.max(1, event.timeStamp - current.startAt);
    move(0);
    if (event.type === "pointerup" && (current.dy <= -SWIPE_DISTANCE_PX || velocity > SWIPE_VELOCITY)) leave("up");
  };

  return (
    <div className={styles.anchor}>
      <div
        className={styles.card}
        data-buy-alert
        data-dragging={dragging || undefined}
        data-leaving={leaving ?? undefined}
        data-mounted={mounted || undefined}
        onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}
        onFocus={() => setFocused(true)}
        onPointerCancel={onPointerEnd}
        onPointerDown={onPointerDown}
        onPointerEnter={(event) => { if (event.pointerType === "mouse") setHovered(true); }}
        onPointerLeave={(event) => { if (event.pointerType === "mouse") setHovered(false); }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onTransitionEnd={(event) => { if (leaving && event.target === event.currentTarget && event.propertyName === "opacity") onClose(); }}
        ref={card}
      >
        {/* The name beside it is the same link: one tab stop, one announced name. */}
        <Link aria-hidden className={styles.who} href={alert.actor.path} tabIndex={-1}>
          <Avatar accountId={alert.actor.callsign} avatarUrl={alert.actor.avatar_url} size={28} />
        </Link>
        {/* The name has its own line and cuts off alone, so the amount, coin and cap stay readable. */}
        <p className={styles.text}>
          <Link className={styles.name} href={alert.actor.path}>{text.name}</Link>
          {/* Spaces for screen readers and copy; flex and grid drop them from the layout. */}
          {" "}
          <span className={styles.what}>
            <span className={styles.fixed}>{text.amount === null ? "bought" : `bought ${text.amount} of`}</span>
            {" "}
            <Link className={styles.coin} href={coinHref}>
              <CoinMark coin={{ key: alert.coin.coin_type, iconUrl: alert.coin.icon_url, coinType: alert.coin.coin_type }} size={16} />
              <span className={styles.symbol}>{text.symbol}</span>
            </Link>
            {text.cap === null ? null : <>{" "}<span className={styles.cap}>{`· ${text.cap} cap`}</span></>}
          </span>
        </p>
        <IconButton aria-label="Dismiss" className={styles.close} onClick={() => leave("up")} size="touch" variant="ghost">
          <CloseIcon />
        </IconButton>
      </div>
    </div>
  );
}
