
import { DateStamp } from "#web/components/blast-ui/DateStamp.tsx";
import { coinPagePath } from "@blast/core/modules/launchpad-coin/page-key.ts";
import { shortAddress as shortId, venueName } from "@blast/core/lib/format.ts";
import { LoadingIndicator } from "#web/components/blast-ui/LoadingIndicator.tsx";
import Link from "next/link";
import { useId, type ReactNode } from "react";

import type {
  LaunchMatch,
  PagedGroup,
  SearchGroup,
  SearchLaunch,
  ThesisMatch,
} from "@blast/core/modules/launchpad-search/contracts.ts";
import { LIFECYCLE_LABELS } from "../discovery/discovery-model";
import { dataStatePresentation, type DataStateKind } from "../primitives/data-state";
import { Glyph } from "../primitives/Glyph";
import { MetadataIcon } from "../primitives/MetadataIcon";
import primitives from "../primitives/primitives.module.css";
import styles from "./Search.module.css";
import { anyGroupAnswered, GROUP_INFO, groupWithMore, matchCount, type GroupView, type SearchView } from "./search-model";

/**
 * The grouped results of one search, in the served order: identifier groups
 * first. Every row is a canonical Blast launch (or a public thesis on one)
 * linking to its coin, with enough identity to tell duplicates apart. A
 * group that is Unavailable or Stale says so in words; groups with nothing
 * are summed up in one line; no match at all offers Clear search and Launch.
 * State lines are not live regions: the search field's status line speaks.
 */

/** A state line in the primitives' look, without its own live region. */
function StateNote({ kind, children }: Readonly<{ kind: DataStateKind; children: ReactNode }>) {
  const { label, glyph } = dataStatePresentation(kind);
  return (
    <p className={primitives.stateLine} data-state={kind}>
      <span className={primitives.stateLabel}>
        <Glyph shape={glyph} />
        {label}
      </span>{" "}
      <span className={primitives.stateMessage}>{children}</span>
    </p>
  );
}

const MATCH_LABELS: Readonly<Record<LaunchMatch["match"], string>> = {
  launch_id: "launch ID",
  pool_id: "pool ID",
  creator: "creator wallet",
  coin_type: "coin type",
  ticker: "Ticker match",
  name: "Name match",
  words: "Words in name or ticker",
};

const EXACT = new Set<LaunchMatch["match"]>(["launch_id", "pool_id", "creator", "coin_type"]);

function MatchReason({ item }: Readonly<{ item: LaunchMatch }>) {
  if (!EXACT.has(item.match)) return <span className={styles.match}>{MATCH_LABELS[item.match]}</span>;
  const what = item.match === "pool_id" && item.pool ? `${venueName(item.pool.venue)} pool ID` : MATCH_LABELS[item.match];
  return (
    <span className={styles.match}>
      <span className={styles.exact}>Exact</span> {what}
    </span>
  );
}

/** Ticker, lifecycle and name: the first lines of every row. */
function LaunchTitle({ launch }: Readonly<{ launch: SearchLaunch }>) {
  return (
    <>
      <span className={styles.icon}>
        <MetadataIcon src={launch.iconUrl} identity={launch.coinType} size={32} />
      </span>
      <span className={styles.symbol} data-missing={launch.symbol === null || undefined}>{launch.symbol ?? "No ticker"}</span>
      <span className={styles.lifecycle}>{LIFECYCLE_LABELS[launch.lifecycle]}</span>
      <span className={styles.name} data-missing={launch.name === null || undefined}>{launch.name ?? "Unnamed coin"}</span>
    </>
  );
}

function LaunchRow({ item, onChoose }: Readonly<{ item: LaunchMatch; onChoose: () => void }>) {
  const { launch } = item;
  return (
    <li>
      <Link className={styles.row} href={coinPagePath(launch.coinType)} title={`Launch ID ${launch.launchId}`} onClick={onChoose}>
        <LaunchTitle launch={launch} />
        <MatchReason item={item} />
        <span className={styles.identity}>
          Launch <code>{shortId(launch.launchId)}</code> · Creator{" "}
          {launch.creator ? <code>{shortId(launch.creator)}</code> : "not known yet"} · Created <DateStamp at={launch.createdAtMs} plain />
        </span>
      </Link>
    </li>
  );
}

const KINDS: Readonly<Record<ThesisMatch["thesis"]["kind"], string>> = {
  creator_thesis: "Creator thesis",
  creator_update: "Creator update",
  community_thesis: "Community thesis",
};

const AUTHOR_LABELS: Readonly<Record<string, string>> = { creator: "Creator", wallet: "Disclosed wallet" };

function ThesisRow({ item, onChoose }: Readonly<{ item: ThesisMatch; onChoose: () => void }>) {
  const { thesis, launch } = item;
  const stance = thesis.stance ? thesis.stance.charAt(0).toUpperCase() + thesis.stance.slice(1) : null;
  const about = [KINDS[thesis.kind], stance, ...thesis.authorLabels.map((label) => AUTHOR_LABELS[label] ?? label)].filter(Boolean);
  return (
    <li>
      <Link className={`${styles.row} ${styles.thesisRow}`} href={coinPagePath(launch.coinType)} onClick={onChoose}>
        <LaunchTitle launch={launch} />
        <span className={styles.identity}>
          Launch <code>{shortId(launch.launchId)}</code>
        </span>
        <span className={styles.about}>{about.join(" · ")}</span>
        <span className={styles.body}>{thesis.body}</span>
        <span className={styles.posted}>
          Posted <DateStamp at={thesis.postedAt} plain />
          {thesis.createdAt !== thesis.postedAt ? (
            <>
              {" · "}
              revised <DateStamp at={thesis.createdAt} plain />
            </>
          ) : null}
        </span>
      </Link>
    </li>
  );
}

function listing(labels: readonly string[], conjunction: "and" | "or"): string {
  return labels.length < 2 ? labels.join("") : `${labels.slice(0, -1).join(", ")} ${conjunction} ${labels.at(-1)}`;
}

/** What a group finds, as the noun of an empty search. */
const NOUNS: Readonly<Record<SearchGroup, string>> = {
  onchain: "launch or pool ID",
  wallets: "wallet",
  coins: "coin",
  theses: "thesis",
  profiles: "profile",
};

function GroupSection({
  entry,
  headingId,
  busy,
  onMore,
  onChoose,
}: Readonly<{
  entry: GroupView;
  headingId: string;
  /** A newer search is running: these rows are about to be replaced. */
  busy: boolean;
  onMore: (group: PagedGroup) => void;
  onChoose: () => void;
}>) {
  const info = GROUP_INFO[entry.group];
  const { state } = entry;
  const rows = (state.status === "ready" || state.status === "stale") && state.value.items.length > 0;
  let content: ReactNode = null;
  if (state.status === "unavailable") {
    content = <StateNote kind="unavailable">{info.label} couldn’t load.</StateNote>;
  } else if (state.status === "ready" || state.status === "stale") {
    content = <GroupMatches entry={entry} state={state} rows={rows} busy={busy} onMore={onMore} onChoose={onChoose} />;
  }
  return (
    <section aria-labelledby={headingId} className={styles.group} data-search-group={entry.group}>
      <div className={styles.groupHeader}>
        <h3 id={headingId} className={styles.groupTitle}>{info.label}</h3>
        {info.order && rows ? <p className={styles.order}>{info.order}</p> : null}
      </div>
      {content}
    </section>
  );
}

function GroupMatches({ entry, state, rows, busy, onMore, onChoose }: Readonly<{
  entry: GroupView;
  state: Extract<GroupView["state"], { status: "ready" | "stale" }>;
  rows: boolean;
  busy: boolean;
  onMore: (group: PagedGroup) => void;
  onChoose: () => void;
}>) {
  const info = GROUP_INFO[entry.group];
  return (
    <>
      {state.status === "stale" ? <StateNote kind="stale">These results may be out of date.</StateNote> : null}
      {!rows && state.value.nextCursor && entry.group !== "profiles" ? (
        <p className={styles.note}>No {info.more} found yet; more remain to search.</p>
      ) : null}
      {rows ? (
        <ol className={styles.list}>
          {state.value.items.map((item) => ("thesis" in item
            ? <ThesisRow key={item.thesis.id} item={item} onChoose={onChoose} />
            : <LaunchRow key={item.launch.launchId} item={item} onChoose={onChoose} />))}
        </ol>
      ) : null}
      {entry.pageError ? <StateNote kind="unavailable">More results couldn’t load. Try again.</StateNote> : null}
      {state.value.nextCursor && entry.group !== "profiles" ? (
        // aria-disabled, not disabled: a focused button that is disabled drops focus to the page.
        <button
          className={styles.more}
          type="button"
          onClick={() => {
            if (!entry.loadingMore && !busy) onMore(entry.group as PagedGroup);
          }}
          aria-disabled={entry.loadingMore || busy || undefined}
          aria-busy={entry.loadingMore || undefined}
        >
          {entry.loadingMore ? <LoadingIndicator label={`Loading more ${info.more}`}>Show more {info.more}</LoadingIndicator> : `Show more ${info.more}`}
        </button>
      ) : null}
    </>
  );
}

export function SearchResults({
  view,
  busy = false,
  onMore,
  onClear,
  onRetry,
  onChoose,
}: Readonly<{
  view: SearchView;
  /** A newer search is running; Show more waits for it. */
  busy?: boolean;
  onMore: (group: PagedGroup) => void;
  onClear: () => void;
  onRetry: () => void;
  /** Called when a result or Launch is chosen, before the route changes. */
  onChoose: () => void;
}>) {
  const id = useId();
  switch (view.status) {
    case "idle":
      return null;
    case "searching":
      return <StateNote kind="loading">Searching Blast launches…</StateNote>;
    case "invalid":
      return null;
    case "failed":
      return (
        <div className={styles.state}>
          <StateNote kind="unavailable">Search couldn’t finish.</StateNote>
          <p className={styles.actions}>
            <button className={styles.textButton} type="button" onClick={onRetry}>Try again</button>
          </p>
        </div>
      );
    case "results": {
      const answered = anyGroupAnswered(view);
      // A group that read only skipped posts but has more to read has not found nothing yet.
      const nothing = matchCount(view).matches === 0 && groupWithMore(view) === null;
      // A stale answer with no rows found nothing too, as of its last verified read.
      const empty = view.groups.filter((entry) => entry.state.status === "empty" ||
        (entry.state.status === "stale" && entry.state.value.items.length === 0));
      const shown = view.groups.filter((entry) => entry.state.status !== "empty");
      return (
        <div className={styles.results}>
          {!answered ? (
            <div className={styles.state}>
              <StateNote kind="unavailable">Search couldn’t finish.</StateNote>
              <p className={styles.actions}>
                <button className={styles.textButton} type="button" onClick={onRetry}>Try again</button>
              </p>
            </div>
          ) : nothing ? (
            <div className={styles.state}>
              <StateNote kind="empty">
                No Blast {listing(empty.map((entry) => NOUNS[entry.group]), "or")} matches “{view.query}”.
              </StateNote>
              <p className={styles.actions}>
                <button className={styles.textButton} type="button" onClick={onClear}>Clear search</button>
                <Link href="/launch" onClick={onChoose}>Launch a coin</Link>
              </p>
            </div>
          ) : null}
          {shown.map((entry) => (
            <GroupSection
              key={entry.group}
              entry={entry}
              headingId={`${id}-${entry.group}`}
              busy={busy}
              onMore={onMore}
              onChoose={onChoose}
            />
          ))}
          {!nothing && empty.length > 0 ? (
            <p className={styles.note}>No matches in {listing(empty.map((entry) => GROUP_INFO[entry.group].label), "and")}.</p>
          ) : null}
        </div>
      );
    }
  }
}
