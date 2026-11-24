"use client";
import { Button } from "#web/components/blast-ui/Button.tsx";

import { useCallback, useId, useRef, useState } from "react";
import { InspectValue } from "#web/components/blast-ui/InspectValue.tsx";
import { Sheet, SheetClose, SheetHeading } from "#web/components/blast-ui/Sheet.tsx";
import { PanelEmptyState } from "./PanelEmptyState";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { ago } from "#web/components/social/post/post-format.ts";
import { VerifiedBadge } from "#web/components/blast-ui/Icons.tsx";
import { PostCard } from "#web/components/social/post/PostCard.tsx";
import { postView } from "#web/components/social/post/post-model.ts";
import { SOCIAL_FEED_DELAYED_LAG_MS } from "@blast/core/web/contracts/feed.ts";
import { useCoinRead } from "./use-coin-read";
import type { HomeDiscussionPage } from "@blast/core/web/contracts/home.ts";
import type { CoinAsset, CoinReads } from "./coin-reads";
import { ActorAvatar } from "../ActorCell";
import { actorIdentity, type ActorIdentity } from "../actor-identity";
import styles from "./CoinPanel.module.css";

/** `noun` and `emptyTitle` name the list for the tab it sits under (the coin's Theses tab says theses, audit 25), in its empty and failed states. */
export function CoinPosts({asset,reads,visible,noun="Posts",emptyTitle="No posts yet"}:Readonly<{asset:CoinAsset;reads:Pick<CoinReads, "posts">;visible:boolean;noun?:"Posts" | "Theses";emptyTitle?:string}>) {
  const [cursor,setCursor]=useState<string|null>(null);
  const [selected,setSelected]=useState<{ presaleId: string | null; item: HomeDiscussionPage["items"][number]; nowMs: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [offset,setOffset]=useState(0);
  const title=useId();
  const load=useCallback((signal:AbortSignal)=>reads.posts?.(asset,cursor,signal) ?? Promise.resolve(null),[asset,cursor,reads]);
  const read=useCoinRead(visible && asset.presale_id !== null,`${asset.network}:${asset.presale_id}:${cursor ?? "latest"}`,load);
  const page=read.value?.presale_id === asset.presale_id ? read.value : null;
  const lastOffset = Math.max(0, Math.floor(((page?.items.length ?? 0) - 1) / 3) * 3);
  const pageOffset = Math.min(offset, lastOffset);
  if (offset !== pageOffset) setOffset(pageOffset);
  const item = selected?.presaleId === asset.presale_id ? selected.item : null;
  function list() {
  if(!asset.presale_id || !reads.posts)return <PanelEmptyState title={`${noun} unavailable for this coin`} />;
  if(read.status === "error")return <EmptyState role="alert" title={`${noun} could not load`} action={<Button variant="secondary" size="sm" type="button" onClick={read.retry}>{`Retry ${noun.toLowerCase()}`}</Button>} />;
  if(!page)return read.status === "pending" ? <div role="status" aria-label="Loading coin posts"><SkeletonText>Post author and summary</SkeletonText></div> : <PanelEmptyState title={`${noun} unavailable for this coin`} />;
  const nowMs=page.as_of.timestamp_ms+page.as_of.lag_ms;
  return <>
    {page.as_of.lag_ms > SOCIAL_FEED_DELAYED_LAG_MS && <p role="status" className={styles.note}>Posts may be delayed.</p>}
    {page.items.length === 0 ? <PanelEmptyState title={emptyTitle} /> : <ol className={styles.posts} aria-label="Coin posts">{page.items.slice(pageOffset,pageOffset+3).map(item => <CoinPostRow key={item.entry_id} item={item} nowMs={nowMs} onSelect={() => setSelected({ presaleId: asset.presale_id, item, nowMs })} />)}</ol>}
    <PostPagination page={page} cursor={cursor} offset={pageOffset} setCursor={setCursor} setOffset={setOffset} />
  </>;
  }
  return <>
    <div ref={listRef} tabIndex={-1} aria-label="Coin posts">{list()}</div>
    <Sheet open={Boolean(item) && visible} onRequestClose={()=>setSelected(null)} labelledBy={title} onClosed={() => {
      if (document.activeElement === document.body) listRef.current?.focus({ preventScroll: true });
    }}>
      <SheetClose onClick={()=>setSelected(null)}/><SheetHeading id={title} title="Post"/>
      {item && (postView(item,null) ? <PostCard item={item} nowMs={selected!.nowMs} variant="detail"/> : <p>Activity from a newer post type.</p>)}
    </Sheet>
  </>;
}

/** Blast's own posts carry no actor; they keep the Blast name and the same avatar treatment. */
const BLAST_AUTHOR: ActorIdentity = { kind: "account", callsign: "Blast", name: "Blast", avatarUrl: null, verified: false };

function CoinPostRow({ item, nowMs, onSelect }: Readonly<{
  item: HomeDiscussionPage["items"][number];
  nowMs: number;
  onSelect: () => void;
}>) {
  const identity = item.actor ? actorIdentity(item.actor) : BLAST_AUTHOR;
  const author = identity.kind === "account" ? identity.name : identity.short;
  const view = postView(item, null);
  const body = view?.body;
  const summary = view?.why ?? (body?.kind === "news" ? body.headline : body?.kind === "action" ? [body.chip, body.amount, body.tail].filter(Boolean).join(" · ") : "Activity");
  const at = new Date(item.occurred_at_ms);
  return (
    <li>
      <ActorAvatar identity={identity} size={28} />
      <Button variant="ghost" size="sm" type="button" aria-label={`Read post by ${author}: ${summary.slice(0, 140)}`} onClick={onSelect}>
        <span className={styles.postMeta}>
          <strong className={identity.kind === "wallet" ? "mono" : undefined}>{author}</strong>
          {identity.kind === "account" && identity.verified ? <VerifiedBadge className={styles.verified} /> : null}
          {item.actor?.type === "account" ? <span>@{item.actor.callsign}</span> : null}
        </span>
        <span className={styles.postText} title={summary}>{summary}</span>
      </Button>
      <time className={styles.postTime} dateTime={at.toISOString()}><InspectValue label="post time" value={at.toUTCString()}>{ago(item.occurred_at_ms, nowMs)}</InspectValue></time>
    </li>
  );
}

function PostPagination({ page, cursor, offset, setCursor, setOffset }: Readonly<{
  page: HomeDiscussionPage;
  cursor: string | null;
  offset: number;
  setCursor: (cursor: string | null) => void;
  setOffset: (offset: number) => void;
}>) {
  return (
    <div className={styles.postPages}>
      {offset > 0 && <Button variant="ghost" size="sm" type="button" className={styles.pill} onClick={()=>setOffset(Math.max(0,offset-3))}>Previous posts</Button>}
      {offset+3 < page.items.length && <Button variant="ghost" size="sm" type="button" className={styles.pill} onClick={()=>setOffset(offset+3)}>More posts</Button>}
      {cursor && <Button variant="ghost" size="sm" type="button" className={styles.pill} onClick={()=>{setCursor(null);setOffset(0);}}>Latest posts</Button>}
      {offset+3 >= page.items.length && page.next_cursor && <Button variant="ghost" size="sm" type="button" className={styles.pill} onClick={()=>{setCursor(page.next_cursor);setOffset(0);}}>Older posts</Button>}
    </div>
  );
}
