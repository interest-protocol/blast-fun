"use client";

import { hoverExcerpt } from "#web/lib/hover-text.ts";
import { LoadingIndicator } from "#web/components/blast-ui/LoadingIndicator.tsx";
import { AlertCircleIcon } from "#web/components/blast-ui/Icons.tsx";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Sheet, SheetClose, SheetCta, SheetHeading } from "#web/components/blast-ui/Sheet.tsx";
import { Pager } from "#web/components/blast-ui/Pager.tsx";
import type { AllowlistErrorCategory, AllowlistRowError, ParsedAllowlist } from "./allowlist-csv";
import { cx } from "./cx";

const PAGE_SIZE = 50;
const CATEGORY_LABELS: Readonly<Record<AllowlistErrorCategory, string>> = {
  address: "invalid addresses", duplicate: "duplicate wallets", number: "invalid numbers",
  zero: "zero amounts", precision: "precision errors", maximum: "amounts over the maximum",
  columns: "column errors", header: "header errors", limit: "rows over the limit",
  empty: "empty files", other: "other issues",
};

function formatAmount(amount: string): string {
  const [whole, fraction] = amount.split(".");
  // Leading zeros are valid, so grouping must stay linear in the amount's length.
  const firstGroupLength = whole.length % 3 || 3;
  const groups = whole.slice(firstGroupLength).match(/\d{3}/g) ?? [];
  return [whole.slice(0, firstGroupLength), ...groups].join(",") + (fraction === undefined ? "" : `.${fraction}`);
}

export function AllowlistReview({ parsed, fileName, symbol, busy, errors, uploadError, onAccept, onClose, saved = false }: Readonly<{
  parsed: ParsedAllowlist;
  fileName: string;
  symbol: string;
  busy: boolean;
  errors: readonly AllowlistRowError[];
  uploadError: string | null;
  onAccept: () => void;
  onClose: () => void;
  saved?: boolean;
}>) {
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState(true);
  const focus = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const pagination = useRef<HTMLDivElement>(null);
  const invalid = parsed.errorCount > 0 || errors.length > 0;
  const pages = Math.ceil(parsed.n / PAGE_SIZE);
  const start = page * PAGE_SIZE;
  useEffect(() => () => {
    if (!document.querySelector('[role="dialog"][aria-modal="true"]')) returnFocus.current?.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(() => {
    if (scroll.current) scroll.current.scrollTop = 0;
    const active = document.activeElement;
    if (active?.matches("button:disabled") && pagination.current?.contains(active)) {
      pagination.current.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus({ preventScroll: true });
    }
  }, [page, uploadError]);
  const close = () => { if (!busy) setOpen(false); };
  return (
    <Sheet className={cx("cr-sheet", invalid ? "cr-csv-sheet" : "cr-list-sheet")} hasCta initialFocus={() => {
      returnFocus.current = document.querySelector<HTMLButtonElement>('[data-cr-upload][data-f="allowlist"]') ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      return focus.current;
    }} labelledBy="cr-list-title" onClosed={onClose} onRequestClose={close} open={open}>
      <SheetClose disabled={busy} onClick={close} />
      {invalid ? <InvalidAllowlist errors={errors} fileName={fileName} focus={focus} parsed={parsed} symbol={symbol} uploadError={uploadError} /> : (
        <>
          <div className={cx("cr-list-header")} ref={focus} tabIndex={-1}>
            <SheetHeading id="cr-list-title" lead={<span className={cx("cr-list-filename")} title={hoverExcerpt(fileName)}>{fileName}</span>} title="Review your allowlist" />
            <p className={cx("cr-list-summary")}>{parsed.n.toLocaleString("en-US")} wallets · Limits: {formatAmount(parsed.minAmount)}–{formatAmount(parsed.maxAmount)} {symbol}</p>
            {!saved ? <p>Accepting replaces your existing allowlist.</p> : null}
          </div>
          {uploadError ? <div className={cx("cr-list-notice")} role="alert"><AlertCircleIcon /><div><strong>Your list couldn&apos;t upload</strong><p>{uploadError}</p></div></div> : null}
          <div aria-label="Allowlist wallets" className={cx("cr-list-scroll cr-list-body")} ref={scroll} role="region" tabIndex={0}>
            <table aria-label="Wallet contribution limits" className={cx("cr-list-table")}>
              <thead><tr><th scope="col">Wallet</th><th scope="col">Maximum ({symbol})</th></tr></thead>
              <tbody>
                {parsed.entries.slice(start, start + PAGE_SIZE).map((entry) => <tr key={entry.wallet}><td><code>{entry.wallet}</code><span className={cx("cr-list-line")}>{saved ? "Saved row" : "CSV line"} {saved ? entry.line - 1 : entry.line}</span></td><td>{formatAmount(entry.amount)}</td></tr>)}
              </tbody>
            </table>
          </div>
          {pages > 1 ? <div className={cx("cr-list-pages")} ref={pagination}>
            <Pager onPage={(next) => setPage(next - 1)} page={page + 1} pages={pages} pending={busy} what="wallets" />
          </div> : null}
        </>
      )}
      <ReviewActions busy={busy} invalid={invalid} onAccept={onAccept} onClose={close} saved={saved} />
    </Sheet>
  );
}

function ReviewActions({ busy, invalid, onAccept, onClose, saved }: Readonly<{
  busy: boolean; invalid: boolean; onAccept(): void; onClose(): void; saved: boolean;
}>) {
  return <SheetCta className={cx("cr-cta")}>
    {invalid || saved ? null : <button className="btn btn-primary" disabled={busy} onClick={onAccept} type="button">{busy ? <LoadingIndicator label="Uploading allowlist">Accept allowlist</LoadingIndicator> : "Accept allowlist"}</button>}
    <button className={invalid ? "btn btn-primary" : "btn btn-quiet"} disabled={busy} onClick={onClose} type="button">{invalid ? "Back to upload" : saved ? "Done" : "Cancel"}</button>
  </SheetCta>;
}

function InvalidAllowlist({ parsed, errors, fileName, symbol, uploadError, focus }: Readonly<{
  parsed: ParsedAllowlist;
  errors: readonly AllowlistRowError[];
  fileName: string;
  symbol: string;
  uploadError: string | null;
  focus: RefObject<HTMLDivElement | null>;
}>) {
  const shownErrors = errors.length ? errors : parsed.errors;
  const issueCount = errors.length || parsed.errorCount;
  const affected = errors.length ? new Set(errors.filter((error) => error.field !== "File").map((error) => error.line)).size : parsed.affectedRowCount;
  const categories = errors.length ? Object.groupBy(errors, (error) => error.category) : null;
  const counts = categories ? Object.entries(categories).map(([category, rows]) => [category, rows!.length] as const) : Object.entries(parsed.errorCategories);
  return <>
    <header className={cx("cr-csv-header")}>
      <div aria-labelledby="cr-list-title" ref={focus} tabIndex={-1}>
        <SheetHeading id="cr-list-title" lead={<span className={cx("cr-csv-filename")} title={hoverExcerpt(fileName)}>{fileName}</span>} title="Fix your CSV" />
      </div>
      <ErrorSummary affected={affected} issueCount={issueCount} reported={errors.length > 0} rowCount={parsed.rowCount} />
      {issueCount > 5 ? <ul aria-label="Issue categories" className={cx("cr-csv-categories")}>
        {counts.map(([category, count]) => <li key={category}>{count} {CATEGORY_LABELS[category as AllowlistErrorCategory]}</li>)}
      </ul> : null}
      <p className={cx("cr-csv-rules")}>Addresses: 0x followed by 1–64 hex characters. Amounts in {symbol}: positive plain numbers, no thousands separators, at most {parsed.decimals} decimal places. Amounts are never rounded.</p>
      {uploadError ? <p className={cx("cr-csv-rules")}>{uploadError}</p> : null}
    </header>
    <div aria-label="CSV diagnostics" className={cx("cr-csv-diagnostics")} role="region" tabIndex={0}>
      <ul className={cx("cr-list-errors")}>
        {shownErrors.map((error) => <li key={`${error.line}-${error.field}-${error.reason}`}>
          <span className={cx("cr-csv-line")}>Line {error.line}</span>
          <span className={cx("cr-csv-field")}>{error.field}</span>
          <code>{error.value || <span className={cx("cr-csv-empty")}>Empty value</span>}</code>
          <span className={cx("cr-csv-reason")}>{error.reason}</span>
        </li>)}
      </ul>
      {issueCount > shownErrors.length ? <p className={cx("cr-csv-rules")}>Showing the first {shownErrors.length} of {issueCount.toLocaleString("en-US")} issues. The entire file is blocked.</p> : null}
    </div>
  </>;
}

function ErrorSummary({ affected, rowCount, issueCount, reported }: Readonly<{
  affected: number;
  rowCount: number;
  issueCount: number;
  reported: boolean;
}>) {
  const issueWord = issueCount === 1 ? "issue" : "issues";
  return <p className={cx("cr-csv-summary")} role="alert">
    <strong>{reported ? "Reported: " : null}{affected ? `${affected.toLocaleString("en-US")} ${affected === 1 ? "row needs" : "rows need"} attention out of ${rowCount.toLocaleString("en-US")}` : "Your CSV needs attention"}</strong>
    <span>No changes made.{issueCount !== affected ? ` ${issueCount.toLocaleString("en-US")} ${issueWord} ${reported ? "reported" : "found"}.` : ""}</span>
  </p>;
}
