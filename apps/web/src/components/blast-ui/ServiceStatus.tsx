"use client";

import { Popover } from "@base-ui/react/popover";
import clsx from "clsx";
import { useRef, useState } from "react";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { usePortalContainer } from "#web/components/ui-libraries/portal.ts";
import { Button } from "./Button";
import { SkeletonBox } from "./Skeleton";
import { impactLine, useHealthRead } from "./service-status.ts";
import styles from "./ServiceStatus.module.css";

const backendLabels = { healthy: "Operational", degraded: "Degraded", unavailable: "Unavailable" };
const suiLabels = { healthy: "Operational", stale: "Delayed", unavailable: "Unavailable" };

/**
 * The one calm line a page shows instead of empty lists while they are late
 * (an empty list then would say "nothing" when the truth is "not yet").
 * Its marker lets Home hide the sections whose lists came back empty.
 */
export function ListsLate({ className }: Readonly<{ className?: string }>) {
  const client = useAppQueryClient();
  const [trying, setTrying] = useState(false);
  const retry = () => {
    setTrying(true);
    void client.refetchQueries({ type: "active" }).finally(() => setTrying(false));
  };
  return <div className={clsx(styles.late, className)} data-list-empty="">
    <p className={styles.lateText} role="status">Lists are late. Your balances are safe.</p>
    <Button loading={trying} loadingLabel="Trying lists again" onClick={retry} size="sm" variant="ghost">Try again</Button>
  </div>;
}

function useServiceHealth() {
  const health = useHealthRead();
  const data = health.data;
  const fresh = data && !health.isError && !health.isStale;
  const backend = fresh ? data.backend : null;
  const sui = fresh ? data.sui.status : null;
  const pending = health.isPending;
  const online = backend === "healthy" && sui === "healthy";
  const label = statusLabel(pending, Boolean(fresh), online);
  const tone = pending || !fresh ? "unknown" : online ? "healthy" : "degraded";
  const unknownLabel = "Checking…";
  const backendLabel = backend ? backendLabels[backend] : unknownLabel;
  const suiLabel = sui ? suiLabels[sui] : unknownLabel;

  // A failed or stale read says what to do instead of listing "Unknown" twice.
  const checked = pending || Boolean(fresh);
  const impact = checked ? impactLine(backend, sui) : "We can’t check right now.";

  return { health, pending, label, tone, backendLabel, suiLabel, impact, checked };
}

export function ServiceStatus({ mobile = false, navigation = false, popupId }: Readonly<{ mobile?: boolean; navigation?: boolean; popupId?: string }>) {
  const container = usePortalContainer();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const { health, pending, label, tone, backendLabel, suiLabel, impact, checked } = useServiceHealth();

  if (!navigation && tone !== "degraded" && !open && !focused) return null;

  return (
    <div className={navigation ? styles.navigation : mobile ? styles.mobile : styles.desktop}>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger ref={trigger} className={styles.trigger} aria-label={`Service status: ${label}`} title={navigation ? undefined : label} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}>
          <StatusIcon pending={pending} tone={tone} />
          <span className={styles.label}>{navigation ? "Service status" : label}</span>
        </Popover.Trigger>
        <Popover.Portal container={container}>
          <Popover.Positioner sideOffset={8} collisionPadding={16} className={styles.layer}>
            <Popover.Popup id={popupId} className={styles.popup} onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }} finalFocus={() => {
              if (trigger.current?.getClientRects().length && (navigation || tone === "degraded")) return true;
              return Array.from(document.querySelectorAll<HTMLButtonElement>("[data-more-navigation]"))
                .find((button) => button.getClientRects().length > 0) ?? true;
            }}>
              <Popover.Title className={styles.title}>Service status</Popover.Title>
              <p className={styles.summary} role="status">{label}</p>
              {checked ? <dl className={styles.facts}>
                <div><dt>Backend connection</dt><dd>{backendLabel}</dd></div>
                <div><dt>Sui connection</dt><dd>{suiLabel}</dd></div>
              </dl> : null}
              {impact ? <p className={styles.impact}>{impact}</p> : null}
              <div className={styles.actions}>
                {/* TS-4: Refresh is the one action; Close is the quiet way out. */}
                <Button size="sm" loading={health.isFetching} loadingLabel="Refreshing service status" onClick={() => { void health.refetch(); }}>Refresh</Button>
                <Popover.Close render={<Button size="sm" variant="ghost" />}>Close</Popover.Close>
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

function statusLabel(pending: boolean, fresh: boolean, online: boolean): string {
  if (pending) return "Checking services";
  if (!fresh) return "Status unavailable";
  return online ? "Services online" : "Service disruption";
}

function StatusIcon({ pending, tone }: Readonly<{ pending: boolean; tone: string }>) {
  if (pending) return <SkeletonBox className={styles.iconSkeleton} round />;
  const symbols: Record<string, string> = { healthy: "", degraded: "!", unknown: "?" };
  return <span className={styles.icon} data-tone={tone} aria-hidden="true">{symbols[tone]}</span>;
}
