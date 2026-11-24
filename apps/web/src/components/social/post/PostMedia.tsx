"use client";

import clsx from "clsx";

import { CoinArtwork } from "#web/components/blast-ui/CoinArtwork.tsx";

import { HelmetMark } from "../feed-ui/icons";
import { AccountAvatar } from "../AccountAvatar";
import styles from "./PostCard.module.css";

/**
 * The pictures of a post: an account's avatar (`.av`), a presale's mark
 * (`.mk`) and an anonymous wallet's gradient (`.wav`). A remote picture must
 * be a public `https` URL (an X photo loads at the width that is sharp at
 * its size); a missing, unusable or broken one becomes a
 * colorful gradient derived from the identity (the same rule as every
 * avatar and coin icon in the app), never an official mark. Decorative: the
 * name next to the picture says who.
 */

const avatarSize = { 44: "", 30: styles.s30, 26: styles.s26 } as const;

/** An account's round avatar at one of the design's sizes. */
export function Avatar({ src, callsign, size = 44 }: Readonly<{ src: string | null; callsign: string; size?: 44 | 30 | 26 }>) {
  return (
    <span aria-hidden="true" className={clsx(styles.av, avatarSize[size])}>
      <AccountAvatar accountId={callsign} avatarUrl={src} size={size} />
    </span>
  );
}

const markSize = { 72: styles.s72, 44: "", 34: styles.s34, 20: styles.s20, 18: styles.s18 } as const;

/** A presale's mark (a rounded tile), with the "Posted by Blast" badge on a presale's own post. */
export function PresaleMark({
  src,
  presaleId,
  coinType,
  size = 44,
  badge = false,
}: Readonly<{ src: string | null; presaleId: string; coinType?: string; size?: 72 | 44 | 34 | 20 | 18; badge?: boolean }>) {
  return (
    // R3-07: every mark also carries its own key (`mk-<key>`), so one coin's mark can be styled on its own.
    <span aria-hidden="true" className={clsx(styles.mk, markSize[size], `mk-${presaleId}`)}>
      <CoinArtwork fallbackId={presaleId} coinType={coinType} size={size} src={src} />
      {badge ? (
        <span className={styles.badge} title="Posted by Blast">
          <HelmetMark />
        </span>
      ) : null}
    </span>
  );
}

/**
 * An anonymous wallet's gradient circle (44, 40 on phones): the design's
 * `linear-gradient(140deg, hsl(H 70% 66%), hsl(H+52 64% 50%))`, drawn as an
 * SVG gradient with the same line (presentation attributes, so the page's CSP,
 * which allows no inline styles, holds).
 */
export function WalletAvatar({ hue }: Readonly<{ hue: number }>) {
  const id = `wav-${hue}`;
  return (
    <span aria-hidden="true" className={styles.wav}>
      <svg preserveAspectRatio="none" viewBox="0 0 1 1">
        <defs>
          <linearGradient id={id} x1="0.047" x2="0.953" y1="-0.04" y2="1.04">
            <stop offset="0" stopColor={`hsl(${hue} 70% 66%)`} />
            <stop offset="1" stopColor={`hsl(${(hue + 52) % 360} 64% 50%)`} />
          </linearGradient>
        </defs>
        <rect fill={`url(#${id})`} height="1" width="1" />
      </svg>
    </span>
  );
}
