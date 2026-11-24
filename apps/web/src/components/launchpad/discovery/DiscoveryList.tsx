
import { DateStamp } from "#web/components/blast-ui/DateStamp.tsx";
import { coinPagePath } from "@blast/core/modules/launchpad-coin/page-key.ts";
import { shortAddress as shortId } from "@blast/core/lib/format.ts";
import { CoinVerifiedMark } from "#web/components/blast-ui/Icons.tsx";
import { LoadingIndicator } from "#web/components/blast-ui/LoadingIndicator.tsx";
import Link from "next/link";

import type { DiscoveryRow, DiscoveryViewName } from "@blast/core/modules/launchpad-discovery/rows.ts";

import { DataState } from "../primitives/DataState";
import type { SectionState } from "../primitives/data-state";
import { MetadataIcon } from "../primitives/MetadataIcon";
import styles from "./Discovery.module.css";
import { LIFECYCLE_LABELS, orderFact, VIEW_INFO, type ViewList } from "./discovery-model";

function DiscoveryRowLink({
  view,
  row,
  selected,
  onChoose,
}: Readonly<{ view: DiscoveryViewName; row: DiscoveryRow; selected: boolean; onChoose?: (launchId: string) => void }>) {
  return (
    <li>
      <Link
        className={styles.row}
        href={coinPagePath(row.coinType)}
        data-launch-id={row.launchId}
        aria-current={selected ? "page" : undefined}
        title={`Launch ID ${row.launchId}`}
        onClick={() => onChoose?.(row.launchId)}
      >
        <span className={styles.icon}>
          <MetadataIcon src={row.iconUrl} identity={row.coinType} size={32} />
        </span>
        <span className={styles.symbol} data-missing={row.symbol === null || undefined}>
          {row.verifiedTeam
            ? <span className="coinNamed sm"><span className="nm">{row.symbol ?? "No ticker"}</span><CoinVerifiedMark size="sm" /></span>
            : row.symbol ?? "No ticker"}
        </span>
        <span className={styles.name} data-missing={row.name === null || undefined}>
          {row.name ?? "Unnamed coin"}
        </span>
        <span className={styles.lifecycle}>{LIFECYCLE_LABELS[row.lifecycle]}</span>
        <span className={styles.identity}>
          <code>{shortId(row.launchId)}</code>
          {row.partner ? <span> · Partner launch</span> : null}
        </span>
        <span className={styles.fact}>
          {view === "new" ? <>Created <DateStamp at={row.createdAtMs} plain /></>
            : view === "graduated" && row.graduatedAtMs !== null ? <>Graduated <DateStamp at={row.graduatedAtMs} plain /></>
              : orderFact(view, row)}
        </span>
      </Link>
    </li>
  );
}

/** The next useful actions when a view lists nothing. */
function EmptyActions({
  view,
  onShowView,
}: Readonly<{ view: DiscoveryViewName; onShowView: (view: DiscoveryViewName) => void }>) {
  return (
    <span className={styles.emptyActions}>
      {view === "new" ? null : (
        <button className={styles.textButton} type="button" onClick={() => onShowView("new")}>
          Show all launches
        </button>
      )}
      <Link href="/launch">Launch a coin</Link>
    </span>
  );
}

/**
 * One discovery view's launches in the order blast-infra served them, each a
 * link to its coin. Loading, Empty and Unavailable show no rows; Stale keeps
 * the last verified rows under an explicit label with their provenance.
 */
export function DiscoveryList({
  view,
  state,
  selectedLaunchId,
  loadingMore,
  onLoadMore,
  onShowView,
  onChoose,
}: Readonly<{
  view: DiscoveryViewName;
  state: SectionState<ViewList>;
  selectedLaunchId: string | null;
  loadingMore: boolean;
  onLoadMore: () => void;
  onShowView: (view: DiscoveryViewName) => void;
  /** Called when a launch is chosen, before the route changes. */
  onChoose?: (launchId: string) => void;
}>) {
  const info = VIEW_INFO[view];
  return (
    <DataState
      state={state}
      subject="launches"
      empty={info.empty}
      action={<EmptyActions view={view} onShowView={onShowView} />}
      recovery="Use Refresh to try again."
    >
      {(list) => (
        <>
          {list.rows.length === 0 ? (
            <p className={styles.note}>{info.empty}</p>
          ) : (
            <ol className={styles.list} aria-label={`${info.label} launches`}>
              {list.rows.map((row) => (
                <DiscoveryRowLink
                  key={row.launchId}
                  view={view}
                  row={row}
                  selected={row.launchId === selectedLaunchId}
                  onChoose={onChoose}
                />
              ))}
            </ol>
          )}
          {list.nextCursor ? (
            <button
              className={styles.more}
              type="button"
              onClick={onLoadMore}
              disabled={loadingMore}
              aria-busy={loadingMore || undefined}
            >
              {loadingMore ? <LoadingIndicator label="Loading more launches">Load more launches</LoadingIndicator> : "Load more launches"}
            </button>
          ) : null}
        </>
      )}
    </DataState>
  );
}
