"use client";
import { CopyButton } from "#web/components/blast-ui/CopyButton.tsx";
import { useToast } from "#web/components/blast-ui/Toasts.tsx";
import { SITE_ORIGIN } from "#web/lib/site.ts";
import { vestingPath } from "@blast/core/modules/vesting/model.ts";
import styles from "./Vesting.module.css";
export function VestingShare({ id }: Readonly<{ id: string }>) {
  const toast = useToast();
  return (
    <CopyButton
      size="sm"
      label="Copy public vesting link"
      onCopy={async () => {
        const url = `${SITE_ORIGIN}${vestingPath(id)}`;
        if (navigator.clipboard) {
          await navigator.clipboard.writeText(url);
          toast("Public link copied");
          return true;
        }
        if (navigator.share) {
          await navigator.share({ url, title: "Vesting on Blast" });
          return false;
        }
        throw new Error("Clipboard unavailable");
      }}
    />
  );
}
export function Address({ value }: Readonly<{ value: string }>) {
  return <span className={styles.address}>{value}</span>;
}
