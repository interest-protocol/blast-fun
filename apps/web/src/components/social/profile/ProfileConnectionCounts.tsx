"use client";

import clsx from "clsx";
import { Fragment } from "react";
import { Button } from "#web/components/blast-ui/Button.tsx";
import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { IntentLink } from "#web/components/blast-ui/NavigationLink.tsx";
import { PublicError } from "#web/lib/errors.ts";
import { connectionsPagePath } from "@blast/core/web/contracts/connections.ts";
import type { IdentityProfile } from "./IdentityCard";
import { useConnectionCounts, usePrefetchConnections } from "./use-connections";
import styles from "./Connections.module.css";

/** "1,204 followers · 312 following" (the Profile board), each a link to its list. */
export function ProfileConnectionCounts({ profile, own, loading = false, className }: Readonly<{ profile: IdentityProfile; own: boolean; loading?: boolean; className?: string }>) {
  const prefetch = usePrefetchConnections(profile.callsign, profile.private);
  const counts = useConnectionCounts(profile.callsign, profile.private);
  if ((profile.private && !own) || (counts.error instanceof PublicError && counts.error.code === "not_found")) return null;
  if (loading) return <ProfileConnectionCountsSkeleton className={className} />;
  return <div className={clsx(styles.counts, className)} aria-busy={counts.isPending || undefined}>
    {(["followers", "following"] as const).map((tab, index) => <Fragment key={tab}>
      {index > 0 ? <span aria-hidden="true">·</span> : null}
      <IntentLink href={connectionsPagePath(profile.callsign, tab)} onMouseEnter={() => prefetch(tab)} onFocus={() => prefetch(tab)}>
        <b>{counts.data ? counts.data[tab].toLocaleString("en-US") : counts.isPending ? <SkeletonText>000</SkeletonText> : "—"}</b> {tab}
      </IntentLink>
    </Fragment>)}
    {counts.isError ? <Button className={styles.retryCounts} onClick={() => void counts.refetch()} size="xs" variant="ghost">Retry counts</Button> : null}
  </div>;
}

function ProfileConnectionCountsSkeleton({ className }: Readonly<{ className?: string }>) {
  return <div aria-hidden="true" className={clsx(styles.counts, className)}>
    {["followers", "following"].map((label, index) => <Fragment key={label}>
      {index > 0 ? <span>·</span> : null}
      <span className={styles.countPlaceholder}><b><SkeletonText>000</SkeletonText></b> {label}</span>
    </Fragment>)}
  </div>;
}
