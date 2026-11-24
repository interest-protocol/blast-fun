"use client";

import { diagnosticMessage } from "#web/lib/errors.ts";

import clsx from "clsx";

import { ClientOnly } from "#web/components/ui-libraries/use-hydrated.tsx";

import TrendPlot from "./TrendPlot";
import styles from "./Profile.module.css";
import { GlobeIcon } from "./icons";
import { moneyParts, type GoldFigures } from "./profile-model";
import { trendCaption, type PortfolioTrendView } from "./portfolio-trend";
import type { Loadable } from "./use-profile-data";

/**
 * Another account's public portfolio (OA-10): the gold card, rebuilt as the
 * reference's `gold gold2` (R3-08, FEATURE-MAP-R3 §6) — content height, the
 * total at 44 px (36 on phones) beside a 30-day line, marked Public. One's own
 * portfolio is on `/portfolio` (R3-74); the own profile draws no gold card
 * (R3-76, oa41 `viewProfile`: `showPf = !own && a.openPortfolio`).
 *
 * **The 30-day line is the account's daily snapshots** (OA-25 Q16): the
 * portfolio read's `trend`, written once a UTC day by the social worker. Until
 * the account has a month of them the slot is empty — no line, no caption, no
 * placeholder figure — and keeps its box, so the card's height is the same
 * before and after the line arrives (`portfolio-trend.ts`). Nothing here
 * computes a series.
 */
export function GoldCard({
  name,
  gold,
  trend = null,
}: Readonly<{
  name: string;
  gold: Loadable<GoldFigures>;
  /** The 30-day line; null until the account has a month of daily snapshots (OA-25 Q16). */
  trend?: PortfolioTrendView | null;
}>) {
  const total = gold.status === "ready" ? gold.value.total : null;
  const loading = gold.status === "loading" || gold.status === "none";
  const caption = trend ? trendCaption(trend) : null;
  return (
    <div aria-busy={loading || undefined} aria-label={`${name}'s presale portfolio`} className={clsx(styles.gold, styles.gold2)} role="group">
      <div className={styles.goldTop}>
        <span className={styles.l}>
          Presale portfolio
          <span className={styles.glassChip}>
            <GlobeIcon />
            Public
          </span>
        </span>
      </div>
      <div className={styles.g2Mid}>
        <div className={styles.g2Val}>
          <div className={styles.goldVal}>
            {total === null ? (
              gold.status === "error" ? <span className={styles.goldNote}>{gold.message ?? diagnosticMessage("This portfolio could not load. Try again later.")}</span> : <span aria-hidden="true">—</span>
            ) : (
              <>
                {moneyParts(total).whole}
                <span className={styles.c}>{moneyParts(total).cents}</span>
              </>
            )}
          </div>
        </div>
        {trend && caption ? (
          <div aria-label={caption.description} className={styles.g2Chart} role="img">
            <div className={styles.g2Spark} data-slot="portfolio-sparkline">
              <TrendLine trend={trend} />
            </div>
            {caption.value === null ? null : (
              <span className={styles.g2Cap}>
                {caption.label} <b>{caption.value}</b>
              </span>
            )}
          </div>
        ) : (
          // Less than a month of snapshots: the slot keeps its box and shows nothing (R3-08-AC-5).
          <div aria-hidden="true" className={styles.g2Chart}>
            <div className={styles.g2Spark} data-slot="portfolio-sparkline" />
          </div>
        )}
      </div>
    </div>
  );
}

/** A noninteractive30-day snapshot chart; its slot stays empty until real history exists. */
function TrendLine({ trend }: Readonly<{ trend: PortfolioTrendView }>) {
  return (
    <ClientOnly>
      <TrendPlot trend={trend} />
    </ClientOnly>
  );
}
