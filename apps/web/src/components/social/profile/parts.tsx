"use client";

import clsx from "clsx";
import type { CSSProperties } from "react";

import { CheckIcon, CloseIcon } from "#web/components/blast-ui/Icons.tsx";
import { STEPS, stepIndex, stepLabel, stepProgress } from "@blast/core/modules/presale/presentation.ts";
import { AccountAvatar } from "#web/components/social/AccountAvatar.tsx";
import type { ProfilePresale, ProfilePresaleStatus } from "@blast/core/web/contracts/profile-page.ts";

import styles from "./Profile.module.css";
import { CoinArtwork } from "#web/components/blast-ui/CoinArtwork.tsx";
import { STATUS_LABELS } from "./profile-model";

/**
 * A presale's logo (`.mk`, 34): its https (or inline raster/SVG) icon, else a
 * tile in the presale's first letter. R3-07: the mark carries its own key as
 * `mk-<key>`, so one coin's mark can be styled on its own.
 */
export function PresaleMark({ presale }: Readonly<{ presale: Pick<ProfilePresale, "icon_url" | "symbol"> & Readonly<{ presale_id?: string; coin_type?: string }> }>) {
  return <span aria-hidden="true" className={styles.mk}><CoinArtwork src={presale.icon_url} coinType={presale.coin_type} fallbackId={presale.presale_id ?? "unknown"} size={34} /></span>;
}

/** A round account avatar at one of the design's sizes, decorative. The seed keeps a generated avatar stable. */
export function Avatar({ seed, url, size }: Readonly<{ seed: string; url: string | null; size: 18 | 34 | 40 | 89 }>) {
  return (
    <span aria-hidden="true" className={clsx("av", `s${size}`)}>
      <AccountAvatar accountId={seed} avatarUrl={url} size={size} />
    </span>
  );
}

/**
 * A status chip. `status` is the app-wide class, defined once in
 * `blast-ui.css` (R3-04: Open is pink, Trading neutral), so it is not
 * re-declared here — a module class would be hashed and miss that definition.
 */
export function StatusChip({ status }: Readonly<{ status: ProfilePresaleStatus }>) {
  return (
    <span className="status" data-tone={status}>
      {STATUS_LABELS[status]}
    </span>
  );
}

/** A coin's round mark (`.mk.round.mk-<key>`, 34): USDC's logo, or SUI's drop on white, as the design's marks draw them. */
export function CoinMark({ coin }: Readonly<{ coin: "usdc" | "sui" }>) {
  return (
    <span aria-hidden="true" className={clsx(styles.mk, styles.round, `mk-${coin}`)}>
      <svg height="34" viewBox="0 0 48 48" width="34">
        {coin === "sui" ? (
          <>
            <rect fill="#fff" height="48" width="48" />
            <image height="28" href="/blast-ui/coins/sui.svg" width="21.9" x="13.1" y="10" />
          </>
        ) : (
          <image height="48" href="/blast-ui/coins/usdc.svg" width="48" />
        )}
      </svg>
    </span>
  );
}

/** The same reachable lifecycle as the sale page, without entrance motion in a list. */
export function CompactStepper({ presale, nowMs }: Readonly<{ presale: ProfilePresale; nowMs: number }>) {
  const status = presale.status === "open" && nowMs >= presale.end_ms ? "closed" : presale.status;
  if (status === "cancelled") {
    return (
      <div className={clsx(styles.stepper, styles.stepperCancelled)}>
        <CloseIcon />
        <span>Cancelled · the target was missed</span>
      </div>
    );
  }
  const at = stepIndex(status);
  const progress = stepProgress(
    status,
    { startMs: presale.start_ms, endMs: presale.end_ms },
    nowMs,
  );
  return (
    <ol aria-label={`Presale progress: ${stepLabel(STEPS[at]!, status)}`} className={styles.stepper}>
      {STEPS.map((label, index) => (
        <li aria-current={index === at ? "step" : undefined} aria-label={`${stepLabel(label, status)}: ${index < at ? "Complete" : index === at ? "Current" : "Upcoming"}`} className={index < at ? styles.done : index === at ? styles.now : undefined} key={label}>
          {index === at && progress > 0 && index < STEPS.length - 1 ? (
            <span aria-hidden="true" className={styles.stBar} style={{ "--p": progress.toFixed(3) } as CSSProperties} />
          ) : null}
          <span className={styles.stDot}>{index < at ? <CheckIcon /> : null}</span>
          <span className={styles.stL}>{stepLabel(label, status)}</span>
        </li>
      ))}
    </ol>
  );
}
