"use client";

import { pollInterval } from "#web/lib/query/polling.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import { wholeUsd } from "./competition-volume.ts";

import { useId, useRef, useState, type ReactNode, type RefObject } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { keepPreviousData, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { PageHeader } from "#web/components/blast-ui/PageHeader.tsx";
import { Button, DisclosureButton } from "#web/components/blast-ui/Button.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { Pager } from "#web/components/blast-ui/Pager.tsx";
import { SegmentedLinks } from "#web/components/blast-ui/Segmented.tsx";
import { InspectValue } from "#web/components/blast-ui/InspectValue.tsx";
import { CopyButton } from "#web/components/blast-ui/CopyButton.tsx";
import { Collapse } from "#web/components/blast-ui/Collapse.tsx";
import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { ShellAvatar } from "#web/components/blast-ui/ShellAvatar.tsx";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { gatedFetch } from "#web/lib/api-gate-client.ts";
import { responseError } from "#web/lib/errors.ts";
import {
  COMPETITION_PAGE_SIZE,
  socialCompetitionsPath,
  type Competition,
  type CompetitionBoard,
  type CompetitionDirectory,
  type CompetitionMember,
  type CompetitionPeriod,
} from "@blast/core/modules/social/competitions/contracts.ts";
import { CompetitionHero, useViewerRank } from "./CompetitionHeader.tsx";
import { competitionStatus } from "./competition-format.ts";
import styles from "./CompetitionScreen.module.css";

function useCompetitionRead<T>(
  slug: string | null,
  page: number,
  period: CompetitionPeriod = "current",
) {
  return useQuery(
    {
      queryKey: queryKeys.competitions.board(slug, page, period),
      queryFn: async ({ signal }): Promise<T> => {
        const response = await gatedFetch(socialCompetitionsPath({ page, slug, period }), {
          credentials: "same-origin",
          cache: "no-store",
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        });
        if (!response.ok)
          throw responseError(
            await response.json().catch(() => null),
            response,
            "Competitions could not load. Try again.",
          );
        return response.json();
      },
      placeholderData: keepPreviousData,
      staleTime: 0,
      gcTime: 0,
      refetchInterval: (query) => pollInterval(30_000, query),
      retry: 1,
    },
    useAppQueryClient(),
  );
}

export function CompetitionReadPending() {
  return (
    <div
      role="status"
      aria-label="Loading competitions"
      aria-busy="true"
      className={styles.pending}
    >
      {[0, 1, 2, 3, 4].map((key) => (
        <div key={key} className={styles.skeleton}>
          <SkeletonText>Member name</SkeletonText>
          <SkeletonText>$12,340.50</SkeletonText>
        </div>
      ))}
    </div>
  );
}
function ReadError({ retry, pending, title = "Competitions couldn’t load" }: Readonly<{ retry: () => void; pending: boolean; title?: string }>) {
  return (
    <EmptyState
      action={<Button loading={pending} loadingLabel="Retrying competitions" onClick={retry} size="sm">Try again</Button>}
      framed
      role="alert"
      title={title}
    >
      Check your connection and try again.
    </EmptyState>
  );
}

function MemberRow({ member, you = false }: Readonly<{ member: CompetitionMember; you?: boolean }>) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const name = member.display_name ?? `@${member.callsign}`;
  return (
    <li className={styles.member} data-you={you || undefined} data-top={member.rank !== null && member.rank <= 3 ? "" : undefined}>
      <div className={styles.row}>
        <span
          className={`num ${styles.rank}`}
          aria-label={member.rank === null ? "Not ranked" : `Rank ${member.rank}`}
        >
          {member.rank ?? "—"}
        </span>
        <ShellAvatar size={34} viewer={{ accountId: member.account_id, avatarUrl: member.avatar_url, callsign: member.callsign }} />
        <Link className={styles.name} href={`/@${member.callsign}`} title={name}>
          {you ? <>You<span className="sr"> ({name})</span></> : name}
        </Link>
        <span className={`num ${styles.volume}`}>
          {member.volume_usd === null ? (
            <span className={styles.unpriced}>USD unavailable</span>
          ) : (
            <InspectValue value={member.volume_usd} label="USD volume">
              {wholeUsd(member.volume_usd)}
            </InspectValue>
          )}
        </span>
        <DisclosureButton
          aria-controls={id}
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Show"} ${name} contributing addresses (${member.addresses.length})`}
          iconOnly
          onClick={() => setOpen(!open)}
          size="sm"
        />
      </div>
      <Collapse id={id} open={open} keepMounted={false}>
        <div className={styles.addresses}>
          <h3>
            {member.swaps} {member.swaps === 1 ? "swap" : "swaps"}
            {member.unpriced_swaps > 0 ? ` · ${member.unpriced_swaps} unpriced` : ""}
            {" · "}Contributing addresses ({member.addresses.length})
          </h3>
          {member.addresses.map((address) => (
            <div key={address} className={styles.address}>
              <InspectValue value={address} label="wallet address">
                {address.slice(0, 8)}…{address.slice(-6)}
              </InspectValue>
              <CopyButton
                label={`Copy wallet address ${address}`}
                onCopy={async () => {
                  await navigator.clipboard.writeText(address);
                  return true;
                }}
              />
            </div>
          ))}
        </div>
      </Collapse>
    </li>
  );
}

function DirectoryEvents({
  competitions,
  nowMs,
  period,
}: Readonly<{
  competitions: readonly Competition[];
  nowMs: number;
  period: CompetitionPeriod;
}>) {
  // No link to Past here: the header's switch already offers it.
  if (competitions.length === 0)
    return <EmptyState
      framed
      title={period === "past" ? "No past competitions yet" : "No current or upcoming competitions"}
    />;
  return (
    <ul className={styles.directory}>
      {competitions.map((competition) => (
        <li key={competition.slug}>
          <CompetitionHero competition={competition} href={`/competitions/${competition.slug}`} nowMs={nowMs} />
        </li>
      ))}
    </ul>
  );
}

/** The board's title row: "Competitions" with the Current & upcoming · Past segmented control at its end. */
function CompetitionsHeader({ period }: Readonly<{ period: CompetitionPeriod | null }>) {
  return (
    <PageHeader
      actions={
        <SegmentedLinks
          items={[
            { href: "/competitions", label: "Current & upcoming", current: period === "current" },
            { href: "/competitions?period=past", label: "Past", current: period === "past" },
          ]}
          label="Competition archive"
        />
      }
      title="Competitions"
    />
  );
}

export function CompetitionDirectoryScreen() {
  const params = useSearchParams();
  const period: CompetitionPeriod = params?.get("period") === "past" ? "past" : "current";
  return <CompetitionDirectory key={period} period={period} />;
}

function CompetitionDirectory({ period }: Readonly<{ period: CompetitionPeriod }>) {
  const [page, setPage] = useState(1);
  const query = useCompetitionRead<CompetitionDirectory>(null, page, period);
  const top = useRef<HTMLDivElement>(null);
  const changePage = (next: number) => {
    setPage(next);
    top.current?.focus({ preventScroll: true });
    top.current?.scrollIntoView({ block: "start" });
  };
  return (
    <div className={styles.screen} ref={top} tabIndex={-1}>
      <CompetitionsHeader period={period} />
      <DirectoryResults onPage={changePage} page={page} period={period} query={query} />
    </div>
  );
}

function DirectoryResults({ onPage, page, period, query }: Readonly<{
  onPage: (page: number) => void;
  page: number;
  period: CompetitionPeriod;
  query: UseQueryResult<CompetitionDirectory>;
}>) {
  const { data, isError, isPlaceholderData } = query;
  const count = data?.competitions.length ?? 0;
  const retry = () => void query.refetch();
  if (isError && count === 0) return <ReadError retry={retry} pending={query.isFetching} />;
  if (!data) return <CompetitionReadPending />;
  const announcement = isPlaceholderData ? "Loading competitions" : count > 0 ? `Page ${page}, ${count} competitions` : "";
  return (
    <>
      {isError ? <EmptyState action={<Button onClick={retry} size="sm">Try again</Button>} compact role="alert" title="Couldn’t refresh competitions" /> : null}
      {isPlaceholderData
        ? <CompetitionReadPending />
        : <DirectoryEvents competitions={data.competitions} nowMs={data.as_of_ms ?? query.dataUpdatedAt} period={period} />}
      <span className="sr" role="status">{announcement}</span>
      <Pager className={styles.pager} hasMore={data.has_more} onPage={onPage} page={page} pending={isPlaceholderData} what="competitions" />
    </>
  );
}

function MemberResults({
  data,
  page,
  pending,
  you,
}: Readonly<{ data: CompetitionBoard; page: number; pending: boolean; you: CompetitionMember | null }>) {
  if (pending) return <CompetitionReadPending />;
  // The viewer's own row closes the board, as the board draws it, unless it is already on this page.
  const own = you !== null && !data.members.some((member) => member.account_id === you.account_id) ? you : null;
  if (data.members.length > 0)
    return (
      <>
        <ol
          className={styles.members}
          aria-label="Members ranked by recorded USD volume"
          start={(page - 1) * COMPETITION_PAGE_SIZE + 1}
        >
          {data.members.map((member) => (
            <MemberRow member={member} key={member.account_id} you={member.account_id === you?.account_id} />
          ))}
        </ol>
        {own ? <ul aria-label="Your place" className={styles.members}><MemberRow member={own} you /></ul> : null}
      </>
    );
  let message = "No eligible traders yet";
  if (page > 1) message = "No members on this page. Try the previous page.";
  else if (data.as_of_ms < data.competition.starts_at_ms)
    message = "The competition has not started yet.";
  return <EmptyState title={message} />;
}

function Leaderboard({ children, heading }: Readonly<{ children: ReactNode; heading: RefObject<HTMLHeadingElement | null> }>) {
  return (
    <section className={`card ${styles.board}`} aria-labelledby="leaderboard-title">
      <div className={styles.boardHead}>
        <h2 id="leaderboard-title" ref={heading} tabIndex={-1}>
          Leaderboard
        </h2>
        <p>Recorded volume · USD</p>
      </div>
      {children}
    </section>
  );
}

export function CompetitionScreen({ slug }: Readonly<{ slug: string }>) {
  const [page, setPage] = useState(1);
  const query = useCompetitionRead<CompetitionBoard>(slug, page);
  const data = query.data?.competition.slug === slug ? query.data : undefined;
  const live = data ? competitionStatus(data.competition, data.as_of_ms) === "Live" : false;
  const viewer = useViewerRank(slug, live);
  const heading = useRef<HTMLHeadingElement>(null);
  const changePage = (next: number) => {
    setPage(next);
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: "start" });
  };
  const period: CompetitionPeriod | null = data ? (competitionStatus(data.competition, data.as_of_ms) === "Ended" ? "past" : "current") : null;
  return (
    <div className={styles.screen}>
      <CompetitionsHeader period={period} />
      {data ? (
        <>
          <CompetitionHero competition={data.competition} membersTotal={data.members_total} nowMs={data.as_of_ms} />
          <Leaderboard heading={heading}>
            {query.isError ? <ReadError retry={() => void query.refetch()} pending={query.isFetching} title="Couldn’t refresh the leaderboard" /> : null}
            <MemberResults data={data} page={page} pending={query.isPlaceholderData} you={viewer?.member ?? null} />
            <span className="sr" role="status">
              {query.isPlaceholderData
                ? "Loading leaderboard"
                : `Page ${page}, ${data.members.length} members`}
            </span>
            <Pager
              className={styles.pager}
              hasMore={data.has_more}
              onPage={changePage}
              page={page}
              pending={query.isPlaceholderData}
              what="members"
            />
          </Leaderboard>
        </>
      ) : query.isError ? (
        <Leaderboard heading={heading}>
          <ReadError retry={() => void query.refetch()} pending={query.isFetching} title="Couldn’t load the leaderboard" />
        </Leaderboard>
      ) : (
        <CompetitionReadPending />
      )}
    </div>
  );
}
