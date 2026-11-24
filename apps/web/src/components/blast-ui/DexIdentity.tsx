"use client";

import { venueName } from "@blast/core/lib/format.ts";

import styles from "./DexIdentity.module.css";

const LOGOS = new Map([
  ["bluefin", "/blast-ui/dex/bluefin.svg"],
  ["cetus", "/blast-ui/dex/cetus.svg"],
  ["aftermath", "/blast-ui/dex/aftermath.svg"],
]);

/** `size`: the mark's side, 16 beside text (default) or the Create boards' 18, 20 and 24. */
export function DexIdentity({ venue, iconOnly = false, size = 16 }: Readonly<{ venue: string; iconOnly?: boolean; size?: 16 | 18 | 20 | 24 }>) {
  const src = LOGOS.get(venue.toLowerCase());
  const name = venueName(venue);
  return (
    <span className={styles.identity} title={name}>
      {src ? (
        // Local brand marks are decorative; keep the box if an asset fails to load.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          alt=""
          aria-hidden="true"
          className={styles.logo}
          data-monochrome={venue.toLowerCase() === "aftermath" || undefined}
          data-size={size === 16 ? undefined : size}
          draggable={false}
          height={size}
          key={src}
          onError={(event) => { event.currentTarget.style.visibility = "hidden"; }}
          src={src}
          width={size}
        />
      ) : null}
      <span className={iconOnly && src ? "sr-only" : styles.name}>{name}</span>
    </span>
  );
}
