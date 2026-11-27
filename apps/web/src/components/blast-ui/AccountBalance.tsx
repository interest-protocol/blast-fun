"use client";

import { balanceAmount, balanceBreakdown, balanceNote, compactBalanceAmount } from "./account-balance-model.ts";

import { Popover } from "@base-ui/react/popover";

import { usePortalContainer } from "#web/components/ui-libraries/portal.ts";

import styles from "./AppShell.module.css";
import { Button, ButtonLink, DisclosureButton, type ControlSize } from "./Button";
import { ChevronIcon } from "./Icons";
import { SkeletonText } from "./Skeleton";
import { PORTFOLIO_PATH } from "./nav";
import type { PortfolioSummaryState } from "./portfolio";

/** The existing Portfolio categories, without another read or an estimated balance. The top bar's chip by default; phones' page wallet passes `sm`. */
export function AccountBalance({ hidden, portfolio, onRetry, size = "chip" }: Readonly<{ hidden: boolean; portfolio: PortfolioSummaryState; onRetry?: () => void; size?: Extract<ControlSize, "chip" | "sm"> }>) {
  const container = usePortalContainer();
  const summary = portfolio.status === "ready" ? portfolio.summary : null;
  const amount = balanceAmount(portfolio, hidden);
  const compactAmount = compactBalanceAmount(summary, hidden, amount);
  const note = balanceNote(portfolio, hidden);
  const partialNote = note?.retry === false ? note.text : null;
  const showLoading = !hidden && portfolio.status === "loading";
  const retry = note?.retry ? onRetry : undefined;
  return (
    <Popover.Root>
      <Popover.Trigger
        render={<DisclosureButton size={size}><BalanceChip amount={amount} compactAmount={compactAmount} loading={showLoading} partial={partialNote !== null && amount !== "Portfolio"} /></DisclosureButton>}
        title={partialNote === null ? undefined : "Some coins have no USD price"}
        aria-label={balanceTriggerLabel(amount, hidden, partialNote)}
        aria-busy={portfolio.status === "loading" || undefined}
        className={styles.accountBalance}
      />
      <Popover.Portal container={container}>
        <Popover.Positioner align="end" className={styles.balancePositioner} collisionPadding={16} sideOffset={8} positionMethod="fixed">
          <Popover.Popup className={styles.balancePopup}>
            <Popover.Title className={styles.balanceTitle}>{note?.title ?? "Your portfolio"}</Popover.Title>
            {note ? <Popover.Description className={styles.balanceDescription}>{note.text}</Popover.Description> : null}
            {/* A failed read says so once (WS-4, TS-2): no total or rows that would each repeat "Unavailable". */}
            {note?.retry ? null : <BalanceValues portfolio={portfolio} hidden={hidden} amount={amount} loading={showLoading} />}
            {retry ? <Button className={styles.balanceAction} onClick={retry}>Try again</Button> : null}
            <Popover.Close render={<ButtonLink className={styles.balanceAction} href={PORTFOLIO_PATH} prefetch={false} variant={retry ? "ghost" : "secondary"} />} nativeButton={false}>
              View portfolio <ChevronIcon />
            </Popover.Close>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function balanceTriggerLabel(amount: string, hidden: boolean, partialNote: string | null): string {
  const label = amount === "Portfolio" ? "Portfolio breakdown" : `Portfolio value, ${hidden ? "hidden" : amount}. Portfolio breakdown`;
  return partialNote === null ? label : `${label}. ${partialNote}`;
}

function BalanceValues({ portfolio, hidden, amount, loading }: Readonly<{ portfolio: PortfolioSummaryState; hidden: boolean; amount: string; loading: boolean }>) {
  const displayAmount = (value: string) => loading ? <span aria-label="Loading balance" role="status"><SkeletonText>$0,000.00</SkeletonText></span> : value;
  return (
    <>
      {amount === "Portfolio" ? null : <p className={styles.balanceTotal}>{displayAmount(amount)}</p>}
      <dl className={styles.balanceBreakdown}>
        {balanceBreakdown(portfolio, hidden).map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{displayAmount(value)}</dd></div>)}
      </dl>
    </>
  );
}

function BalanceChip({ amount, compactAmount, loading, partial }: Readonly<{ amount: string; compactAmount: string; loading: boolean; partial: boolean }>) {
  return (
    <b className="num" data-nav-bal="">
      {loading ? <span aria-hidden="true" className={styles.balancePlaceholder} /> : <>
        <span className={styles.balanceExact}>{amount}</span>
        <span className={styles.balanceCompact}>{compactAmount}</span>
        {partial ? <span> · Partial</span> : null}
      </>}
    </b>
  );
}
