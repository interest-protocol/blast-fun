"use client";

import { DateStamp } from "#web/components/blast-ui/DateStamp.tsx";
import { IconButtonLink } from "#web/components/blast-ui/Button.tsx";
import { ExternalIcon } from "#web/components/blast-ui/Icons.tsx";
import { CopyButton } from "#web/components/blast-ui/CopyButton.tsx";
import { InspectValue } from "#web/components/blast-ui/InspectValue.tsx";
import {
  compactAmount,
  exactAmount,
  readableAmount,
  readableDate,
} from "./detail-format";
import { MAX_DATE_MS } from "./schedule-display";
import styles from "./VestingDetail.module.css";

export function TokenAmount({
  value,
  decimals,
  symbol,
  label,
  compact = true,
}: Readonly<{
  value: bigint | string;
  decimals: number | null;
  symbol: string;
  label: string;
  compact?: boolean | "readable";
}>) {
  const exact = exactAmount(value, decimals);
  const short =
    compact === "readable"
      ? readableAmount(value, decimals)
      : compact
        ? compactAmount(value, decimals)
        : exact;
  const text = (
    <span className={styles.token}>
      <span className={compact ? styles.numeric : styles.exactNumber}>
        {short}
      </span>
      <span className={styles.symbol}>{symbol}</span>
    </span>
  );
  return short === exact ? (
    text
  ) : (
    <InspectValue value={`${exact} ${symbol}`} label={label}>
      {text}
    </InspectValue>
  );
}

export function ExactDate({ value, clock = false }: Readonly<{ value: bigint | string; clock?: boolean }>) {
  const ms = BigInt(value);
  return ms > MAX_DATE_MS
    ? <span className={styles.date}>{readableDate(value)}</span>
    : <DateStamp at={ms} clock={clock} className={styles.date} label="vesting time" />;
}

export function Identifier({
  value,
  label,
  href,
  isWallet = false,
}: Readonly<{
  value: string;
  label: string;
  href?: string;
  isWallet?: boolean;
}>) {
  const short = value.includes("::")
    ? `${value.slice(0, 8)}…::${value.split("::").slice(-2).join("::")}`
    : `${value.slice(0, 8)}…${value.slice(-6)}`;
  return (
    <span className={styles.identifier}>
      <InspectValue value={value} label={label}>
        <span className={styles.shortIdentifier}>{short}</span>
      </InspectValue>
      {isWallet ? <small>Your wallet</small> : null}
      <CopyButton
        size="md"
        label={`Copy full ${label}`}
        onCopy={async () => {
          await navigator.clipboard.writeText(value);
          return true;
        }}
      />
      {href ? (
        <IconButtonLink
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          size="touch"
          aria-label={`View ${label} on Suiscan (opens in new tab)`}
          title={`View ${label} on Suiscan`}
        >
          <ExternalIcon />
        </IconButtonLink>
      ) : null}
    </span>
  );
}
