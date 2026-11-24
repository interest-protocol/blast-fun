"use client";

import type { ReactNode } from "react";
import { Popover, PopoverSurface } from "#web/components/blast-ui/Popover.tsx";
import { Button, ButtonLink } from "#web/components/blast-ui/Button.tsx";
import { CrErr, CrSwitch } from "./fields";
import { CheckIcon } from "./create-icons";
import { cx } from "./cx";

export type AllowlistActions = Readonly<{
  fileName: string | null;
  includeHolders: boolean;
  holderSummary: string | null;
  pending: boolean;
  canToggle: boolean;
  onToggle(value: boolean): void;
  onReview(): void;
  onDownload(): void;
}>;

function Info({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return <Popover.Root>
    <Popover.Trigger aria-label={label} className={cx("cr-info")}>ⓘ</Popover.Trigger>
    <PopoverSurface
      positioner={{ sideOffset: 8, collisionPadding: 16, className: cx("cr-info-layer") }}
      popup={{ "aria-label": label, className: cx("cr-info-popup") }}
    >{children}</PopoverSurface>
  </Popover.Root>;
}

export function AllowlistCard({ actions, busy, count, error, input, onUpload, symbol }: Readonly<{
  actions?: AllowlistActions; busy: boolean; count: number | null; error: string; input: ReactNode; onUpload(): void; symbol: string;
}>) {
  const pending = busy || actions?.pending;
  return <div className={cx("cr-allowlist")}>
    <div className={cx("cr-allowlist-heading")}><b>Allowlist</b><Info label="CSV format">Use one address,amount pair per row. Enter each wallet’s limit in {symbol} without thousands separators.</Info></div>
    <div className={cx("cr-file-card")}>
      <span aria-hidden="true" className={cx("cr-file-mark")}>CSV</span>
      <div className={cx("cr-file-details")}><strong>{count !== null ? actions?.fileName ?? "Your allowlist" : "Add your wallet list"}</strong><span>{count !== null ? `${count.toLocaleString("en-US")} wallets · Maximums in ${symbol}` : "CSV with wallet addresses and limits"}</span></div>
      {count !== null ? <span className={cx("cr-uploaded")}><CheckIcon />Uploaded</span> : null}
      <div className={cx("cr-file-actions")}>
        <FileActions actions={actions} pending={Boolean(pending)} uploaded={count !== null} />
        <Button aria-label="Upload or replace allowlist CSV" data-cr-upload="" data-f="allowlist" disabled={pending} loading={busy} loadingLabel="Saving allowlist" onClick={onUpload} size="sm">{count !== null ? "Replace" : "Upload CSV"}</Button>
        {input}
      </div>
    </div>
    <CrErr message={error} path="allowlist" />
    <div className={cx("cr-holder-row")}><div><span className={cx("cr-allowlist-heading")}><b>Include Blast card holders</b><Info label="How card holders are added">Adds one wallet per card holder, using Privy first, then Slush. New wallets get the average CSV limit, rounded down to the smallest {symbol} unit. Existing limits stay as entered.</Info></span>{actions?.holderSummary ? <span className={cx("cr-holder-summary")}>{actions.holderSummary}</span> : null}</div><CrSwitch checked={actions?.includeHolders ?? false} disabled={pending || !actions?.canToggle} label="Include Blast card holders" onChange={(value) => actions?.onToggle(value)} /></div>
  </div>;
}

function FileActions({ actions, pending, uploaded }: Readonly<{ actions?: AllowlistActions; pending: boolean; uploaded: boolean }>) {
  if (!uploaded) return <ButtonLink download="allowlist-example.csv" href="/examples/allowlist.csv" prefetch={false} size="sm">Example CSV</ButtonLink>;
  return <>
    <Button disabled={pending || !actions} loading={actions?.pending ?? false} loadingLabel="Loading saved allowlist" onClick={actions?.onReview} size="sm">Review</Button>
    <Button disabled={pending || !actions} onClick={actions?.onDownload} size="sm">Download CSV</Button>
  </>;
}
