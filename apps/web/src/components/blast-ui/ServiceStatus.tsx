"use client";

import { pollInterval } from "#web/lib/query/polling.ts";
import { Popover } from "@base-ui/react/popover";
import clsx from "clsx";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { usePortalContainer } from "#web/components/ui-libraries/portal.ts";
import { HEALTH_POLL_MS, HEALTH_STALE_MS, serviceHealthSchema } from "#web/modules/service-health/contracts.ts";
import { Button } from "./Button";
import { SkeletonBox } from "./Skeleton";
import styles from "./ServiceStatus.module.css";

const backendLabels = { healthy: "Operational", degraded: "Degraded", unavailable: "Unavailable" };
const suiLabels = { healthy: "Operational", stale: "Delayed", unavailable: "Unavailable" };

// One poll for the shell's status and every page that asks whether lists are late.
/** A health answer that was not OK; a 4xx means the route is off or gated, not that the backend is down. */
class HealthReadError extends Error {
  constructor(readonly status: number) { super("Health check unavailable."); }
}

function useHealthRead() {
  return useQuery({
    queryKey: ["service-health"],
    async queryFn({ signal }) {
      const response = await fetch("/api/social/health", {
        cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
      });
      if (!response.ok) throw new HealthReadError(response.status);
      return serviceHealthSchema.parse(await response.json());
    },
    staleTime: HEALTH_STALE_MS,
    refetchInterval: (query) => pollInterval(HEALTH_POLL_MS, query),
    refetchOnWindowFocus: "always",
    networkMode: "always",
    retry: false,
  }, useAppQueryClient());
}

/**
 * True while the backend that serves lists is degraded or down: a fresh health read says so,
 * or, with no fresh read, the relay cannot reach it (5xx, timeout). One failed poll after a fresh
 * healthy read, an offline browser or an answer that does not parse is not "late".
 * Only lists with no rows give way to the page-level line.
 */
export function useListsLate(): boolean {
  const health = useHealthRead();
  // A stale answer still counts while its refetch is in flight, so lists do not flash their own empty states.
  if (health.data && (!health.isStale || health.isFetching)) return health.data.backend !== "healthy";
  const error = health.error;
  if (error instanceof HealthReadError) return error.status >= 500;
  return error instanceof DOMException && error.name === "TimeoutError";
}

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

// One line on what a person will notice, instead of the raw connection words.
export function impactLine(backend: keyof typeof backendLabels | null, sui: keyof typeof suiLabels | null): string | null {
  const lists = backend !== null && backend !== "healthy";
  const chain = sui !== null && sui !== "healthy";
  if (lists && chain) return "Coin lists may be late or empty, and trades may confirm slowly.";
  if (lists) return "Coin lists may be late or empty. Your balances are safe.";
  if (chain) return "Trades and balances may update slowly.";
  return null;
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
