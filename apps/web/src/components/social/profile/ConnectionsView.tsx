"use client";

import { scheduleDelay } from "#web/lib/schedule-delay.ts";
import { LoadingIndicator } from "#web/components/blast-ui/LoadingIndicator.tsx";
import { useEffect, useState } from "react";
import { Button } from "#web/components/blast-ui/Button.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { SearchIcon, VerifiedBadge } from "#web/components/blast-ui/Icons.tsx";
import { FieldGroup, TextField } from "#web/components/blast-ui/TextField.tsx";
import { IntentLink } from "#web/components/blast-ui/NavigationLink.tsx";
import { PageHeader } from "#web/components/blast-ui/PageHeader.tsx";
import { PublicError, diagnosticMessage } from "#web/lib/errors.ts";
import type { ConnectionAccount, ConnectionTab } from "@blast/core/web/contracts/connections.ts";
import type { SocialProfile } from "@blast/core/web/contracts/profiles.ts";
import { useSocialViewer } from "../SignInGate";
import { useViewerFollowsYou, useViewerStateStore } from "../ViewerState";
import { BackBar } from "./BackBar";
import { ProfileFollow } from "./IdentityCard";
import { Avatar } from "./parts";
import { useIsOwnProfile } from "./use-profile-data";
import { useConnectionCounts, useConnections, usePrefetchConnections } from "./use-connections";
import { ConnectionRowsLoading } from "./ConnectionsLoading";
import { ConnectionTabs } from "./ConnectionTabs";
import styles from "./Connections.module.css";

export function ConnectionsView({ profile, tab }: Readonly<{ profile: SocialProfile; tab: ConnectionTab }>) {
  const own = useIsOwnProfile(profile.callsign);
  const viewer = useSocialViewer();
  const [selection, setSelection] = useState({ route: tab, selected: tab });
  if (selection.route !== tab) setSelection({ route: tab, selected: tab });
  const activeTab = selection.route === tab ? selection.selected : tab;
  const prefetch = usePrefetchConnections(profile.callsign, profile.private);
  const [listVisit, setListVisit] = useState(0);
  const [search, setSearch] = useState("");
  const [q, setQuery] = useState("");
  useEffect(() => scheduleDelay(() => setQuery(search.trim()), 200), [search]);
  const query = useConnections(profile.callsign, profile.private, activeTab, q);
  const counts = useConnectionCounts(profile.callsign, profile.private);
  const hidden = (profile.private && !own) || [query.error, counts.error].some((error) => error instanceof PublicError && error.code === "not_found");
  const label = activeTab === "followers" ? "Followers" : "Following";
  return <>
    <BackBar href={`/@${profile.callsign}`} label={`@${profile.callsign}`} pageHead={false} />
    <PageHeader title={label} sub={profile.display_name ?? `@${profile.callsign}`} />
    <section className={`card ${styles.panel}`} aria-label={`${profile.callsign} connections`}>
      <ConnectionTabs callsign={profile.callsign} tab={activeTab} counts={hidden ? undefined : counts.data} countsLoading={!hidden && counts.isLoading} prefetch={prefetch} select={(selected) => {
        setSelection({ route: tab, selected }); setListVisit((visit) => visit + 1); setSearch(""); setQuery("");
      }} />
      {!hidden && counts.isError ? <Button className={styles.retryCounts} onClick={() => void counts.refetch()} size="sm" variant="ghost">Retry counts</Button> : null}
      {hidden ? <EmptyState title="These connections are private">Only the account owner can view this list.</EmptyState> : <>
        <FieldGroup className={styles.search}>
          <SearchIcon />
          <TextField aria-label={`Search ${activeTab}`} type="search" placeholder={`Search ${activeTab}`} maxLength={80} value={search} onChange={(event) => setSearch(event.target.value)} />
        </FieldGroup>
        <ConnectionList key={`${profile.callsign}:${viewer.signedIn ? viewer.callsign : "visitor"}:${activeTab}:${listVisit}`} query={query} tab={activeTab} q={q} searching={search.trim() !== q} count={q ? undefined : counts.data?.[activeTab]} ownProfile={own} />
      </>}
    </section>
  </>;
}

type RetainedConnection = { account: ConnectionAccount; index: number; removed: boolean };

function retainedConnectionRows(accounts: Map<string, ConnectionAccount>, retained: Map<string, RetainedConnection>, q: string) {
  const visible = [...accounts.values()].filter((account) => !retained.has(account.callsign));
  const term = q.replace(/^@/, "").toLowerCase();
  for (const held of [...retained.values()].sort((a, b) => a.index - b.index)) {
    if (term && !held.account.callsign.toLowerCase().includes(term) && !held.account.display_name?.toLowerCase().includes(term)) continue;
    visible.splice(Math.min(held.index, visible.length), 0, accounts.get(held.account.callsign) ?? held.account);
  }
  return visible;
}

function ConnectionList({ query, tab, q, searching, count, ownProfile }: Readonly<{ query: ReturnType<typeof useConnections>; tab: ConnectionTab; q: string; searching: boolean; count?: number; ownProfile: boolean }>) {
  const viewer = useSocialViewer();
  const store = useViewerStateStore();
  const [retained, setRetained] = useState<Map<string, RetainedConnection>>(() => new Map());
  const accounts = new Map(query.data?.pages.flatMap((page) => page.accounts).map((account) => [account.callsign, account]) ?? []);
  const visible = retainedConnectionRows(accounts, retained, q);
  useEffect(() => {
    if (!ownProfile || tab !== "following" || !store) return;
    return store.subscribeFollowWrites((target, following) => {
      if (target.kind !== "account") return;
      const index = visible.findIndex((account) => account.callsign === target.callsign);
      const previous = retained.get(target.callsign);
      if (index === -1 && !previous) return;
      setRetained((held) => new Map(held).set(target.callsign, { account: previous?.account ?? visible[index]!, index: previous?.index ?? index, removed: !following }));
    });
  }, [store, ownProfile, tab, visible, retained]);
  if (query.isPending || searching) return <ConnectionRowsLoading tab={tab} count={searching || q ? undefined : count} />;
  if (query.isError && !query.data) return <ConnectionError error={query.error} retry={() => void query.refetch()} />;
  if (visible.length === 0) return <ConnectionEmpty tab={tab} searching={Boolean(q)} />;
  return <>
    <ul className={styles.list} aria-label={tab === "followers" ? "Followers" : "Following"} aria-busy={query.isFetching || searching || undefined}>
      {visible.map((account) => <ConnectionRow hideFollowsYou={ownProfile && tab === "followers"} key={account.callsign} account={account} own={viewer.signedIn && viewer.callsign === account.callsign} removed={retained.get(account.callsign)?.removed ?? false} followingHint={ownProfile && tab === "following" ? !(retained.get(account.callsign)?.removed ?? false) : undefined} />)}
    </ul>
    {query.isError ? <ConnectionError error={query.error} retry={() => void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch())} /> : null}
    {query.hasNextPage ? <div className={styles.more}><Button disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? <LoadingIndicator label="Loading more connections">Load more</LoadingIndicator> : "Load more"}</Button></div> : null}
  </>;
}

function ConnectionEmpty({ tab, searching }: Readonly<{ tab: ConnectionTab; searching: boolean }>) {
  return <EmptyState title={searching ? "No matching people" : tab === "followers" ? "No followers yet" : "Not following anyone yet"} />;
}

function ConnectionRow({ account, own, removed, followingHint, hideFollowsYou }: Readonly<{ hideFollowsYou: boolean; account: ConnectionAccount; own: boolean; removed: boolean; followingHint?: boolean }>) {
  const followsYou = useViewerFollowsYou(account.callsign);
  return <li className={styles.row}>
    <IntentLink className={styles.person} href={`/@${account.callsign}`}>
      <Avatar seed={account.callsign} url={account.avatar_url} size={40} />
      <span className={styles.identity}><b><span>{account.display_name ?? account.callsign}</span>{account.verified ? <VerifiedBadge className="verified" /> : null}</b><span>@{account.callsign}</span>
        <small className={styles.relationship}>{account.private ? "Private account" : followsYou && !hideFollowsYou ? "Follows you" : ""}</small>
      </span>
    </IntentLink>
    {own ? <span className={styles.you}>You</span> : <div className={styles.rowAction}><ProfileFollow callsign={account.callsign} undo={removed} followingHint={followingHint} />{removed ? <span className={styles.removed}>No longer following</span> : null}</div>}
  </li>;
}

function ConnectionError({ error, retry }: Readonly<{ error: unknown; retry: () => void }>) {
  return <EmptyState action={<Button onClick={retry}>Try again</Button>} role="alert" title="This list couldn’t load">
    {diagnosticMessage("Check your connection and try again.", error instanceof PublicError ? error : { code: "network_unavailable" })}
  </EmptyState>;
}
