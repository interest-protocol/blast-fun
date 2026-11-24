"use client";

import type { ReactNode } from "react";

import { DexIdentity } from "#web/components/blast-ui/DexIdentity.tsx";
import type { HomeKind } from "@blast/core/web/contracts/home.ts";

import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import styles from "./CoinHome.module.css";

/**
 * The card's marks (the owner's "be very visual"): a direction's glyph, the
 * quote coin's logo, the venue's logo. Each is decorative; the words beside
 * it carry the meaning, so a screen reader hears the same line as before.
 */

const GLYPH_PATHS: Readonly<Record<HomeKind, string>> = {
  trade_buy: "M4 12 12 4M6 4h6v6",
  trade_sell: "M4 4l8 8M12 6v6H6",
  presale_commit: "M2.5 4.5h11v2.3a1.7 1.7 0 0 0 0 3.4v2.3h-11v-2.3a1.7 1.7 0 0 0 0-3.4z",
  presale_claim: "M3.5 8.5l3 3 6.5-7",
};

/** A buy's up-right arrow, a sell's down-right arrow, a commitment's ticket, a claim's check. */
export function KindGlyph({ kind, size = 14 }: Readonly<{ kind: HomeKind; size?: number }>) {
  return (
    <svg aria-hidden="true" className={styles.glyph} data-kind={kind} fill="none" height={size} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" viewBox="0 0 16 16" width={size}>
      <path d={GLYPH_PATHS[kind]} />
    </svg>
  );
}

/** The quote coin's logo (USDC and SUI ship one; another quote draws nothing). */
export function QuoteMark({ symbol }: Readonly<{ symbol: string }>) {
  const key = symbol.toLowerCase();
  if (key !== "usdc" && key !== "sui") return null;
  return <CoinMark coin={{ key, iconUrl: null, round: true, symbol }} size={18} />;
}

/** Where the coin trades or will: `Trading on` / `Launches on` and the venue's logo and name. */
export function VenueChip({ prefix, venue }: Readonly<{ prefix: string; venue: string }>) {
  return (
    <span className={styles.venue}>
      {prefix} <DexIdentity venue={venue} />
    </span>
  );
}

/** A section's grip (the right column's `I.grip`): two columns of three dots. */
export function GripGlyph() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <circle cx="9" cy="6" fill="currentColor" r="1.3" />
      <circle cx="15" cy="6" fill="currentColor" r="1.3" />
      <circle cx="9" cy="12" fill="currentColor" r="1.3" />
      <circle cx="15" cy="12" fill="currentColor" r="1.3" />
      <circle cx="9" cy="18" fill="currentColor" r="1.3" />
      <circle cx="15" cy="18" fill="currentColor" r="1.3" />
    </svg>
  );
}

/** A section's hide control: a plain cross. */
export function CloseGlyph() {
  return (
    <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" viewBox="0 0 24 24">
      <path d="M7 7l10 10M17 7L7 17" />
    </svg>
  );
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Draw known coin symbols as marks while keeping their names readable to assistive technology.
 */
export function CoinWordsWithMarks({ text, marks }: Readonly<{ text: string; marks: ReadonlyMap<string, ReactNode> }>) {
  if (marks.size === 0) return <>{text}</>;
  const symbols = [...marks.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const parts = text.split(new RegExp(`(?<![\\w])(${symbols.join("|")})(?![\\w])`));
  return (
    <>
      {parts.map((part, index) => (
        // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- These positional text fragments have no state; repeated fragment strings are not unique keys.
        <span key={index}>
          {index % 2 === 0 ? part : <span className={styles.coinWord}>{marks.get(part)}<span className="sr">{part}</span></span>}
        </span>
      ))}
    </>
  );
}
