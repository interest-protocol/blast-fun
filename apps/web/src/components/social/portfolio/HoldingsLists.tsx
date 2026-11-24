"use client";

import { DateStamp } from "#web/components/blast-ui/DateStamp.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { CoinVerifiedMark } from "#web/components/blast-ui/Icons.tsx";
import { IntentLink as Link } from "#web/components/blast-ui/NavigationLink.tsx";
import { useLayoutEffect, useRef, type ReactNode } from "react";

import { presalePath } from "@blast/core/modules/social/items/do-the-same.ts";
import { ClaimButton } from "#web/components/social/claim/ClaimButton.tsx";
import type { MePresalePosition, MeVesting, ProfilePresale } from "@blast/core/web/contracts/profile-page.ts";

import { VestingShare } from "#web/components/vesting/parts.tsx";
import { vestingPath } from "@blast/core/modules/vesting/model.ts";

import { useHoldingSearch } from "./holding-search";
import { projectClaimPosition } from "../claim/claim-projection";
import { NO_CLAIMS } from "../claim/claim-runner";
import type { Claims } from "../claim/use-claims";
import styles from "../profile/Profile.module.css";
import vestingStyles from "./VestingRow.module.css";
import { CompactStepper, PresaleMark } from "../profile/parts";
import { positionView, vestingView, type HoldingRight } from "../profile/profile-model";

/**
 * The positions and vesting schedules of one's holdings (the gate's
 * `positionsHTML` and `vestingsHTML`, which oa41 leaves as they were): the
 * Portfolio page's Presales and Vestings tabs (R3-74), and the own profile's
 * holdings card until R3-76 takes it off the profile. A refund, tokens or
 * a vested share is claimed in place from its row (A-03, A-04: the gate's
 * `claim` and `vclaim`), through the host's `claims`; the host toasts the
 * answer and its reads repaint the row.
 */

function Right({ right, presaleId, claims, label }: Readonly<{ right: HoldingRight; presaleId: string; claims: Claims; label?: string }>) {
  if (right.kind === "claim") {
    if (claims.available && claims.supports(right.target.kind)) return <ClaimButton claims={claims} label={label ?? right.label} small target={right.target} />;
    // No claim path here (claiming is off, or nobody is signed in): the sale page says why.
    return (
      <Link className="btn btn-primary btn-sm" href={presalePath(presaleId)}>
        {label ?? right.label}
      </Link>
    );
  }
  return (
    <span className={styles.posV}>
      <b>{right.top}</b>
      <span className={right.tone ? styles[right.tone] : undefined}>{right.bottom}{right.bottomAtMs === undefined ? null : <> <DateStamp at={right.bottomAtMs} label="cliff end time" /></>}</span>
    </span>
  );
}

function HoldingTop({ presale, title, sub, figures = false }: Readonly<{ presale: ProfilePresale; title: string; sub: ReactNode; figures?: boolean }>) {
  return (
    <Link className={styles.posTop} href={presalePath(presale.presale_id)}>
      <PresaleMark presale={presale} />
      <span className={styles.t}>
        {presale.verified_team ? <span className={styles.named}><b>{title}</b><CoinVerifiedMark /></span> : <b>{title}</b>}
        <span className={figures ? "num" : undefined}>{sub}</span>
      </span>
    </Link>
  );
}

/** A schedule's line with its cliff kept on one line ("3-mo cliff" never breaks at its hyphen), as the gate's `.nw`. */
function vestingSub(sub: string): ReactNode {
  const at = sub.search(/\d+-mo cliff$/);
  if (at < 0) return sub;
  return (
    <>
      {sub.slice(0, at)}
      <span className={styles.nw}>{sub.slice(at, -" cliff".length)}</span>
      {" cliff"}
    </>
  );
}

/**
 * A schedule's unlocked share. The width is set through the DOM: the page's
 * CSP allows no inline style attribute, which a server-rendered `style`
 * would be (the pattern of the gold card's composition bar).
 */
function UnlockBar({ pct }: Readonly<{ pct: number }>) {
  const fill = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (fill.current) fill.current.style.width = `${pct}%`;
  }, [pct]);
  return (
    <span className={styles.bar}>
      <i ref={fill} />
    </span>
  );
}

type ListClasses = Readonly<{ list?: string; row?: string }>;

const join = (...names: readonly (string | undefined)[]) => names.filter(Boolean).join(" ");

/** The presale positions, each with its compact stepper (R3-85 restyles the stepper). */
export function PositionsList({
  positions,
  hidden,
  nowMs,
  classes = {},
  claims = NO_CLAIMS,
  compact = false,
}: Readonly<{ positions: readonly MePresalePosition[]; hidden: boolean; compact?: boolean; nowMs: number; classes?: ListClasses; claims?: Claims }>) {
  const list = useHoldingSearch(positions, position => `${position.presale.name} ${position.presale.symbol} ${position.presale.presale_id}`, compact ? "claimable-presales" : "presales");
  if (positions.length === 0) return <EmptyState title="Presales you back appear here" />;
  return (
    <div className={join(styles.pfList, classes.list)}>
      {list.search}
      {list.rows.map((position) => {
        const view = positionView(projectClaimPosition(position, claims), hidden, nowMs);
        return (
          <div className={join(styles.posRow, classes.row)} data-compact={compact || undefined} data-list-row={view.presale.presale_id} key={view.presale.presale_id}>
            <HoldingTop presale={view.presale} sub={view.sub} title={view.presale.name} />
            <Right claims={claims} presaleId={view.presale.presale_id} right={view.right} />
            {compact ? null : <CompactStepper nowMs={nowMs} presale={view.presale} />}
          </div>
        );
      })}
      {list.pager}
    </div>
  );
}

/** The vesting schedules paying the viewer's wallets: the unlocked share and Claim or the schedule's state. */
export function VestingsList({
  vestings,
  hidden,
  nowMs,
  classes = {},
  claims = NO_CLAIMS,
  compact = false,
}: Readonly<{ vestings: readonly MeVesting[]; hidden: boolean; compact?: boolean; nowMs: number; classes?: ListClasses; claims?: Claims }>) {
  const list = useHoldingSearch(vestings, vesting => `${vesting.presale.name} ${vesting.presale.symbol} ${vesting.schedule_id}`, compact ? "claimable-vestings" : "presale-vestings");
  if (vestings.length === 0) return <EmptyState title="Nothing vesting" />;
  return (
    <div className={join(styles.pfList, classes.list)}>
      {list.search}
      {list.rows.map((vesting) => {
        const view = vestingView(vesting, hidden, nowMs, claims);
        return (
          <div className={join(styles.posRow, classes.row, compact ? undefined : vestingStyles.row)} data-compact={compact || undefined} data-list-row={vesting.schedule_id} key={vesting.schedule_id}>
            <Link className={join(styles.posTop, compact ? undefined : vestingStyles.identity)} href={vestingPath(vesting.schedule_id)}>
              <PresaleMark presale={view.presale} />
              <span className={styles.t}>
                <b>{view.title}</b>
                <span className="num">{compact ? `${view.balances.available} ${view.presale.symbol}` : vestingSub(view.sub)}</span>
              </span>
            </Link>
            {compact ? null : <dl className={vestingStyles.balances} aria-label={`${view.presale.symbol} vesting balances`}>
              <div><dt>Claimed</dt><dd>{view.balances.claimed} <span>{view.presale.symbol}</span></dd></div>
              <div><dt>Unclaimed</dt><dd>{view.balances.remaining} <span>{view.presale.symbol}</span></dd></div>
              <div><dt>Available to claim</dt><dd>{view.balances.available} <span>{view.presale.symbol}</span></dd></div>
            </dl>}
            <div className={compact ? undefined : vestingStyles.action}><Right claims={claims} label={compact ? "Claim" : undefined} presaleId={view.presale.presale_id} right={view.right} /></div>
            {compact ? null : <>
              <div className={join(styles.vzRow, vestingStyles.progress)}>
                <UnlockBar pct={view.bar} />
                <span>{view.progress}{view.fullyVestAtMs === undefined ? null : <> <DateStamp at={view.fullyVestAtMs} label="full vesting time" /></>}</span>
              </div>
              <div className={vestingStyles.share}><VestingShare id={vesting.schedule_id} /></div>
            </>}
          </div>
        );
      })}
      {list.pager}
    </div>
  );
}
