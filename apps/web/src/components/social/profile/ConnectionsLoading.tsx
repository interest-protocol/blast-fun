"use client";
import { PendingPanel } from "#web/components/blast-ui/PendingPanel.tsx";

import { useParams, usePathname } from "next/navigation";
import { BackBar } from "./BackBar";
import { ConnectionTabs } from "./ConnectionTabs";
import { SearchIcon } from "#web/components/blast-ui/Icons.tsx";
import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { PageHeader } from "#web/components/blast-ui/PageHeader.tsx";
import { FieldGroup, TextField } from "#web/components/blast-ui/TextField.tsx";
import styles from "./Connections.module.css";

export function ConnectionRowsLoading({ tab = "connections", count }: Readonly<{ tab?: string; count?: number }>) {
  if (count === undefined || count === 0) return <PendingPanel label={`Loading ${tab}`} />;
  const rows = Math.min(count, 20);
  return <div role="status" aria-label={`Loading ${tab}`}>
    <span className="sr">Loading {tab}…</span>
    <ul className={styles.list} aria-hidden="true">{Array.from({ length: rows }, (_, row) => <li className={styles.row} key={row}>
      <span className={styles.person}><span className={styles.avatarSkeleton} /><span className={styles.identity}><b><SkeletonText>Connection name</SkeletonText></b><span><SkeletonText>@callsign</SkeletonText></span><small className={styles.relationship} /></span></span>
      {tab === "invites" ? <span className={styles.xHandle}><SkeletonText>@handle</SkeletonText></span> : <span className={styles.buttonSkeleton}><SkeletonText>Following</SkeletonText></span>}
    </li>)}</ul>
  </div>;
}

export function ConnectionsLoading() {
  const pathname = usePathname();
  const params = useParams<{ callsign: string }>();
  const callsign = params?.callsign ?? "";
  const tab = pathname?.endsWith("/following") ? "following" : "followers";
  return <><BackBar href={`/@${callsign}`} label={`@${callsign}`} pageHead={false} /><PageHeader title={tab === "following" ? "Following" : "Followers"} sub={`@${callsign}`} /><section className={`card ${styles.panel}`} aria-label={`${callsign} connections`}>
    <ConnectionTabs callsign={callsign} countsLoading tab={tab} />
    <FieldGroup className={styles.search}><SearchIcon /><TextField aria-label={`Search ${tab}`} placeholder={`Search ${tab}`} disabled type="search" /></FieldGroup>
    <ConnectionRowsLoading tab={tab} />
  </section></>;
}
