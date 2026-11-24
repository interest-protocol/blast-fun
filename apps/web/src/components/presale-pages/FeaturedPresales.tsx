"use client";

import { useId } from "react";
import { usePhoneLayout } from "#web/components/blast-ui/use-shell-prefs.ts";
import { IntentLink as Link } from "#web/components/blast-ui/NavigationLink.tsx";
import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import { CoinVerifiedMark } from "#web/components/blast-ui/Icons.tsx";
import { coreCoin } from "@blast/core/modules/social/portfolio/core-coins.ts";
import type { SocialPresaleSummary } from "@blast/core/web/contracts/presales.ts";
import { ProgressBar } from "#web/components/blast-ui/ProgressBar.tsx";
import { PersonAvatar } from "#web/components/social/PersonAvatar.tsx";
import { ArtworkMark } from "#web/components/blast-ui/ArtworkMark.tsx";
import { catalogCountdown, catalogFunding, catalogTime } from "./catalog-model";
import { FeaturedCarousel } from "./FeaturedCarousel";
import { PresaleCover } from "./PresaleCover";
import type { ViewerPresales } from "./presales-client";
import styles from "./FeaturedPresales.module.css";

const CLOSING_SOON_MS = 24 * 60 * 60 * 1000;

/** The hero's kicker: where the sale stands, then how full it is once it is open (left out without a target). */
function kicker(sale: SocialPresaleSummary, now: number, percentage: string | null): string {
  if (sale.phase === "pending") return sale.interested > 0 ? `Upcoming · ${sale.interested.toLocaleString("en-US")} interested` : "Upcoming";
  const stage = sale.end_ms - now <= CLOSING_SOON_MS ? "Closing soon" : "Live";
  return percentage === null ? stage : `${stage} · ${percentage} filled`;
}

/** Up to three followed backers as decorative faces, with who they are in words ("kenji and 11 people you follow are in"). */
function FollowedBackers({ id, sale, viewer }: Readonly<{ id: string; sale: SocialPresaleSummary; viewer: ViewerPresales | null }>) {
  const following = viewer?.[sale.presale_id]?.following ?? [];
  if (!following.length) return null;
  const first = following[0]!.account;
  const name = first.display_name ?? `@${first.callsign}`;
  const others = following.length - 1;
  return <span className={styles.heroSocial}>
    <span aria-hidden="true" className={styles.heroFaces}>
      {following.slice(0, 3).map((row) => <PersonAvatar key={row.account.callsign} person={row.account} size={26} />)}
    </span>
    <span id={id}><b>{name}</b>{others ? ` and ${others} ${others === 1 ? "person" : "people"} you follow are in` : " is in"}</span>
  </span>;
}

/** The link names the sale and describes its raise, deadline and backers. */
export function FeaturedSale({ sale, now, viewer, className }: Readonly<{ sale: SocialPresaleSummary; now: number; viewer: ViewerPresales | null; className?: string }>) {
  const funding = catalogFunding(sale);
  const countdown = catalogCountdown(sale, now);
  const currency = coreCoin(sale.quote_type);
  const coin = { key: sale.quote_type, coinType: sale.quote_type, iconUrl: currency?.logoUrl ?? null, round: true, symbol: sale.quote_symbol };
  const id = useId();
  const followed = (viewer?.[sale.presale_id]?.following.length ?? 0) > 0;
  const backers = `${sale.participants.toLocaleString("en-US")} ${sale.participants === 1 ? "backer" : "backers"}`;
  return <Link aria-describedby={followed ? `${id}-funding ${id}-social` : `${id}-funding`} aria-labelledby={`${id}-name`} className={`card ${styles.hero} ${className ?? ""}`} href={`/presale/${sale.presale_id}`}>
    <PresaleCover className={styles.heroCover} cover={sale.metadata?.cover} presaleId={sale.presale_id} />
    <span className={styles.heroBody}>
      <span className={styles.heroIdentity}>
        <ArtworkMark coinType={sale.coin_type} src={sale.icon_url} fallbackId={sale.presale_id} size={56} />
        <span className={styles.identity}>
          <span className={styles.heroKicker}>{kicker(sale, now, funding.percentage)}</span>
          {sale.verified_team
            ? <span className={styles.heroName} id={`${id}-name`}><b>{sale.name}</b><CoinVerifiedMark /></span>
            : <b id={`${id}-name`}>{sale.name}</b>}
        </span>
      </span>
      <FollowedBackers id={`${id}-social`} sale={sale} viewer={viewer} />
      <span className={styles.funding}>
        <CoinMark coin={coin} size={28} />
        <b>{funding.committedAmount} {sale.quote_symbol}</b>{" "}
        <span className={styles.muted}>of {funding.targetAmount} {sale.quote_symbol}</span>
      </span>
      <ProgressBar className={styles.progress} label="Funding target progress" pct={funding.progress} />
      <span className={styles.heroDeadline}>{countdown.label ?? "Opens"} <b>{countdown.value}</b></span>
    </span>
    <span hidden id={`${id}-funding`}>{`${funding.description} ${catalogTime(sale, now)}. ${backers}.`}</span>
  </Link>;
}

/**
 * The featured presales above the Presales list: one sale is a static hero;
 * several rotate in the shared featured carousel (auto-advance with segment
 * progress, paused on hover, focus and reduced motion; swipe and arrows).
 */
export function FeaturedPresales({ sales, now, viewer = null }: Readonly<{ sales: readonly SocialPresaleSummary[]; now: number; viewer?: ViewerPresales | null }>) {
  const phone = usePhoneLayout();
  const first = sales[0];
  if (!first) return null;
  return <section aria-label="Selected presales" className={styles.catalogFeatured}>
    {phone ? <FeaturedSale now={now} sale={first} viewer={viewer} /> : (
      <FeaturedCarousel count={sales.length}>
        {sales.map((sale) => <FeaturedSale key={sale.presale_id} now={now} sale={sale} viewer={viewer} />)}
      </FeaturedCarousel>
    )}
  </section>;
}
