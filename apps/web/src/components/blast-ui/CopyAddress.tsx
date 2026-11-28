"use client";

import { shortAddress } from "@blast/core/web/format.ts";

import { CopyButton } from "./CopyButton";
import styles from "./CopyAddress.module.css";

export function CopyAddress({ value, label, copyLabel, name }: Readonly<{
  value: string;
  label?: string;
  copyLabel: string;
  name?: string | null;
}>) {
  const [packageAddress = value] = value.split("::", 1);
  const preview = packageAddress.length > 10 ? shortAddress(packageAddress) : packageAddress;
  const prefix = label ? `${label} ` : "";

  return (
    <CopyButton
      className={styles.control}
      failureMessage="Couldn’t copy the address."
      label={`${prefix}${name ?? preview}. ${copyLabel}`}
      title={copyLabel}
      onCopy={async () => {
        await navigator.clipboard.writeText(value);
        return true;
      }}
    >
      <span>{prefix}{name ?? <code className={styles.value}>{preview}</code>}</span>
    </CopyButton>
  );
}
