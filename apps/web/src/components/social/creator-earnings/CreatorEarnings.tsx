"use client";

import { Button, DisclosureButton } from "#web/components/blast-ui/Button.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { Collapse } from "#web/components/blast-ui/Collapse.tsx";

import Link from "next/link";
import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { CreatorEarningsSkeleton } from "./CreatorEarningsSkeleton";
import { useId, useState, type ReactNode } from "react";
import { Tooltip, TooltipSurface } from "#web/components/blast-ui/Tooltip.tsx";
import { Popover, PopoverSurface } from "#web/components/blast-ui/Popover.tsx";
import { presalePath } from "@blast/core/modules/social/items/do-the-same.ts";
import type {
  CreatorEarning,
  CreatorVesting,
} from "@blast/core/web/contracts/creator-earnings.ts";
import { ClaimButton } from "#web/components/social/claim/ClaimButton.tsx";
import type { ClaimTarget } from "../claim/claims";
import type { Claims } from "../claim/use-claims";
import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import type { CreatorEarningsRead } from "./use-creator-earnings";
import { earningAmount } from "./earning-amount";
import styles from "./CreatorEarnings.module.css";

function collectionReceipt(row: CreatorEarning): string {
  return `${row.received.meme}:${row.received.quote}`;
}

function creatorTarget(row: CreatorEarning, kind: "collect_fees" | "claim_residuals"): ClaimTarget {
  return {
    key: `${kind}:${row.vault_id}`,
    kind,
    presaleId: row.presale_id,
    vaultId: row.vault_id,
    ...(kind === "collect_fees" ? { collection: { received: collectionReceipt(row) } } : {}),
    done: {
      title: kind === "collect_fees" ? "Creator fees collected" : "Launch leftovers claimed",
      sub: `${row.name} · now in your wallet`,
    },
  };
}

function Amounts({
  amounts,
  row,
  hidden,
  estimated = false,
  exact = false,
}: Readonly<{
  amounts: { meme: string; quote: string };
  row: CreatorEarning;
  hidden: boolean;
  estimated?: boolean;
  exact?: boolean;
}>) {
  return (
    <span className={styles.amounts}>
      <span className="num">
        <span className={styles.quantity}>
          {hidden ? "••••" : earningAmount(amounts.meme, estimated, exact)}
        </span>{" "}
        <span className={styles.symbol}>{row.symbol}</span>
      </span>
      <span className="num">
        <span className={styles.quantity}>
          {hidden ? "••••" : earningAmount(amounts.quote, estimated, exact)}
        </span>{" "}
        <span className={styles.symbol}>{row.quote_symbol}</span>
      </span>
    </span>
  );
}

function EarningsAction({
  claims,
  target,
  label,
  ariaLabel,
  disabled = false,
}: Readonly<{
  claims: Claims;
  target: ClaimTarget;
  label: string;
  ariaLabel: string;
  disabled?: boolean;
}>) {
  const view = claims.view(target.key, target.vesting?.claimed, target.collection?.received);
  return (
    <div className={styles.control}>
      <div aria-live="polite">
        <ClaimButton
          ariaLabel={ariaLabel}
          claims={claims}
          disabled={disabled}
          keepVisible={target.kind === "collect_fees"}
          label={label}
          small
          target={target}
        />
      </div>
      {view.state === "failed" ? (
        <p className={styles.refusal} role="alert">
          {view.message}
        </p>
      ) : null}
    </div>
  );
}

function EarningRow({
  label,
  amount,
  children,
}: Readonly<{ label: ReactNode; amount: ReactNode; children?: ReactNode }>) {
  return (
    <div className={styles.action}>
      <span className={styles.label}>{label}</span>
      <div className={styles.value}>{amount}</div>
      {children}
    </div>
  );
}

function TradingFeeHelp({ symbol }: Readonly<{ symbol: string }>) {
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={`${symbol} trading fee estimate help`}
        className={styles.feeHelp}
      >
        Trading fees
      </Popover.Trigger>
      <PopoverSurface
        positioner={{ sideOffset: 6, collisionPadding: 12, className: styles.tooltipLayer }}
        popup={{ className: styles.helpPopup }}
      >
            <Popover.Title className={styles.helpTitle}>Trading fee estimate</Popover.Title>
            <Popover.Description className={styles.helpDescription}>
              Amounts estimate your wallet’s share of collectible fees in each token. Final amounts
              may change before collection.
            </Popover.Description>
          </PopoverSurface>
    </Popover.Root>
  );
}

function DetailsToggle({
  expanded,
  detailsId,
  label,
  onClick,
}: Readonly<{ expanded: boolean; detailsId: string; label: string; onClick: () => void }>) {
  return (
    <DisclosureButton variant="ghost" size="sm"
      aria-controls={detailsId}
      aria-expanded={expanded}
      aria-label={label}
      className={styles.disclosure}
      onClick={onClick}
      type="button"
    >
      Details
    </DisclosureButton>
  );
}

function Earning({
  row,
  claims,
  hidden,
}: Readonly<{ row: CreatorEarning; claims: Claims; hidden: boolean }>) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  return (
    <div className={styles.earning}>
      <Link className={styles.name} href={presalePath(row.presale_id)}>
        <CoinMark
          coin={{ key: row.presale_id, iconUrl: row.icon_url, round: false, symbol: row.symbol }}
          size={40}
        />
        <span>
          <b>{row.name}</b>
          <span>{row.symbol}</span>
        </span>
      </Link>
      <div className={styles.rows}>
        <EarningRow
          label={<TradingFeeHelp symbol={row.symbol} />}
          amount={
            row.collect ? (
              <Amounts amounts={row.collect} row={row} hidden={hidden} estimated />
            ) : row.collection_status === "empty" ? (
              <Amounts amounts={{ meme: "0", quote: "0" }} row={row} hidden={hidden} />
            ) : (
              <span className={styles.localState}>
                {row.collection_status === "unavailable" ? "Fees unavailable" : "Not eligible"}
              </span>
            )
          }
        >
          <EarningsAction
            ariaLabel={`Collect ${row.symbol} trading fees`}
            claims={claims}
            disabled={!row.collect || row.collection_status !== "ready"}
            label="Collect"
            target={creatorTarget(row, "collect_fees")}
          />
        </EarningRow>
        <EarningRow
          label="Launch leftovers"
          amount={
            row.residuals ? (
              <Amounts amounts={row.residuals} row={row} hidden={hidden} />
            ) : (
              <span className={styles.localState}>Nothing to claim</span>
            )
          }
        >
          {row.residuals ? (
            <EarningsAction
              ariaLabel={`Claim ${row.symbol} launch leftovers`}
              claims={claims}
              label="Claim"
              target={creatorTarget(row, "claim_residuals")}
            />
          ) : null}
        </EarningRow>
      </div>
      <DetailsToggle
        detailsId={detailsId}
        expanded={expanded}
        label={`${row.symbol} earnings details`}
        onClick={() => setExpanded(!expanded)}
      />
      <Collapse id={detailsId} open={expanded}><div className={styles.details}>
        <dl>
          <div className={styles.feeShare}>
            <dt>Fee share</dt>
            <dd className="num">{row.fee_share_bps / 100}%</dd>
          </div>
          <div>
            <dt>Collected</dt>
            <dd>
              <Amounts amounts={row.received} row={row} hidden={hidden} exact />
            </dd>
          </div>
          {row.collect ? (
            <div className={styles.precision}>
              <dt>Fee estimate · full precision</dt>
              <dd>
                <Amounts amounts={row.collect} row={row} hidden={hidden} estimated exact />
              </dd>
            </div>
          ) : null}
          {row.residuals ? (
            <div className={styles.precision}>
              <dt>Exact launch leftovers</dt>
              <dd>
                <Amounts amounts={row.residuals} row={row} hidden={hidden} exact />
              </dd>
            </div>
          ) : null}
        </dl>
      </div></Collapse>
    </div>
  );
}

function Allocation({
  row,
  claims,
  hidden,
}: Readonly<{ row: CreatorVesting; claims: Claims; hidden: boolean }>) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const target: ClaimTarget = {
    key: `vesting:${row.schedule_id}`,
    kind: "claim_vesting",
    presaleId: row.presale_id,
    scheduleId: row.schedule_id,
    vesting: { claimed: row.claimed, claimable: row.claimable },
    done: { title: `Claimed your ${row.symbol}`, sub: `${row.name} · now in your wallet` },
  };
  return (
    <div className={styles.earning}>
      <Link className={styles.allocation} href={presalePath(row.presale_id)}>
        <b>{row.name}</b>
        <span>Vested creator allocation</span>
      </Link>
      <div className={styles.rows}>
        <EarningRow
          label="Available to claim"
          amount={
            <span className="num">
              {hidden ? "••••" : earningAmount(row.claimable, true)} {row.symbol}
            </span>
          }
        >
          {/[1-9]/.test(row.claimable) ? (
            <EarningsAction
              ariaLabel={`Claim ${row.symbol} vested allocation`}
              claims={claims}
              label="Claim vested"
              target={target}
            />
          ) : (
            <span className={styles.localState}>Vesting</span>
          )}
        </EarningRow>
      </div>
      <DetailsToggle
        detailsId={detailsId}
        expanded={expanded}
        label={`${row.symbol} allocation details`}
        onClick={() => setExpanded(!expanded)}
      />
      <Collapse id={detailsId} open={expanded}><div className={styles.details}>
        <dl>
          <div>
            <dt>Unlocked estimate · full precision</dt>
            <dd className="num">
              {hidden ? "••••" : earningAmount(row.claimable, true, true)} {row.symbol}
            </dd>
          </div>
          <div>
            <dt>Claimed</dt>
            <dd className="num">
              {hidden ? "••••" : earningAmount(row.claimed, false, true)} {row.symbol}
            </dd>
          </div>
          <div>
            <dt>Total allocation</dt>
            <dd className="num">
              {hidden ? "••••" : earningAmount(row.total, false, true)} {row.symbol}
            </dd>
          </div>
        </dl>
      </div></Collapse>
    </div>
  );
}

function Refresh({ read }: Readonly<{ read: CreatorEarningsRead }>) {
  const busy = read.status === "loading" || read.refreshing;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        aria-busy={busy || undefined}
        aria-disabled={busy || undefined}
        aria-label={busy ? "Refreshing creator earnings" : "Refresh creator earnings"}
        className={styles.refresh}
        onClick={() => {
          if (!busy) read.retry();
        }}
        render={<button type="button" />}
      >
        {busy ? (
          <SkeletonText>↻</SkeletonText>
        ) : (
          <svg
            aria-hidden="true"
            fill="none"
            height="18"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.7"
            viewBox="0 0 24 24"
            width="18"
          >
            <path d="M20 7v5h-5M4 17v-5h5" />
            <path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 17.9 17" />
          </svg>
        )}
      </Tooltip.Trigger>
      <TooltipSurface
        positioner={{ sideOffset: 4, collisionPadding: 12, className: styles.tooltipLayer }}
        popup={{ className: styles.tooltip }}
      >Refresh earnings</TooltipSurface>
    </Tooltip.Root>
  );
}

export function CreatorEarnings({
  read,
  claims,
  hidden,
}: Readonly<{ read: CreatorEarningsRead; claims: Claims; hidden: boolean }>) {
  return (
    <section aria-label="Creator earnings" className={styles.section}>
      <div className={styles.header}>
        <h3>Creator earnings</h3>
        <span className="sr-only" role="status">
          {read.refreshing ? "Updating…" : ""}
        </span>
        <Refresh read={read} />
      </div>
      {read.status === "loading" ? <CreatorEarningsSkeleton /> : null}
      {read.status === "ready" && read.refreshFailed ? (
        <p className={styles.note} role="alert">
          Couldn’t refresh. Showing the last known amounts. Try refreshing again.
        </p>
      ) : null}
      {read.status === "error" ? (
        <EmptyState action={<Button onClick={read.retry}>Try again</Button>} role="alert" title="Creator earnings could not load">
          {read.error}
        </EmptyState>
      ) : null}
      {read.status === "ready" ? (
        <>
          {read.earnings.length === 0 && read.vestings.length === 0 ? (
            <EmptyState title="No creator earnings yet" />
          ) : null}
          {read.earnings.map((row) => (
            <Earning claims={claims} hidden={hidden} key={row.vault_id} row={row} />
          ))}
          {read.vestings.map((row) => (
            <Allocation claims={claims} hidden={hidden} key={row.schedule_id} row={row} />
          ))}
          {read.loadingMore ? <CreatorEarningsSkeleton /> : null}
          {read.more ? (
            <Button
              aria-busy={read.loadingMore || undefined}
              className={styles.more}
              disabled={read.loadingMore}
              onClick={read.loadMore}
            >
              Load more
            </Button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
