"use client";

import { SearchIcon } from "#web/components/blast-ui/Icons.tsx";
import { Pager } from "#web/components/blast-ui/Pager.tsx";
import { FieldGroup, TextField } from "#web/components/blast-ui/TextField.tsx";

import { usePortfolioState } from "./use-portfolio-state";
import styles from "./Portfolio.module.css";

const PAGE_SIZE = 20;

/**
 * Positions and schedules retain their action order; their search covers every row before paging.
 * `search` goes above the rows and `pager` after them; `controls` is both, for hosts that draw one slot.
 */
export function useHoldingSearch<Item>(items: readonly Item[], text: (item: Item) => string, identity = "holdings") {
  const [state, setControls] = usePortfolioState(identity, { search: "", page: 1 });
  const { search, page } = state;
  const setPage = (page: number) => setControls(current => ({ ...current, page }));
  const matching = items.filter(item => text(item).toLowerCase().includes(search.trim().toLowerCase()));
  const pages = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const shown = items.length > PAGE_SIZE || search;
  const searchNode = shown ? <div className={styles.holdingSearch}>
    <FieldGroup className={styles.coinSearch}>
      <SearchIcon />
      <TextField aria-label="Search holdings" autoComplete="off" maxLength={200} onChange={event => { setControls({ search: event.target.value, page: 1 }); }} placeholder="Search name or ticker" type="search" value={search} />
    </FieldGroup>
    {search.trim() ? <p className={styles.holdingMeta} role="status">{matching.length === 0 ? "No matching holdings." : `${matching.length} ${matching.length === 1 ? "holding" : "holdings"}`}</p> : null}
  </div> : null;
  const pager = shown ? <Pager className={styles.coinPager} onPage={setPage} page={current} pages={pages} what="holdings" /> : null;
  return { rows: matching.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE), search: searchNode, pager, controls: <>{searchNode}{pager}</>, searching: !!search.trim() };
}
