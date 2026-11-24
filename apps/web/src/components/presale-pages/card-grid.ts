"use client";

import { useEffect, useLayoutEffect, useState } from "react";

/** Cards revealed per step: 18 is six rows of three, nine of two, eighteen of one. */
const CARDS_PER_STEP = 18;

/** Columns assumed until the grid is measured; the layout most visitors see. */
const DEFAULT_COLUMNS = 3;

/** Whole rows to fill at least `CARDS_PER_STEP` cards, as a card count. */
export function cardStep(columns: number): number {
  return Math.ceil(CARDS_PER_STEP / columns) * columns;
}

/** `wanted` cards rounded up to a full row, so a reveal never ends mid-row. */
export function fullRows(wanted: number, columns: number): number {
  return Math.ceil(wanted / columns) * columns;
}

/** The track count of a computed `grid-template-columns` ("300px 300px 300px" is 3); 0 when it is not a track list. */
export function trackCount(template: string): number {
  const tracks = template.trim();
  return tracks === "" || tracks === "none" ? 0 : tracks.split(/\s+/).length;
}

/**
 * The grid's real column count, read from its computed tracks so the media
 * queries, the sidebar's width and any future layout all count. Pass the
 * returned setter as the grid element's `ref`.
 */
export function useGridColumns(): readonly [(node: HTMLElement | null) => void, number] {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [columns, setColumns] = useState(DEFAULT_COLUMNS);
  useLayoutEffect(() => {
    if (!node) return;
    const read = () => {
      const count = trackCount(getComputedStyle(node).gridTemplateColumns);
      if (count > 0) setColumns(count);
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return [setNode, columns];
}

type CardRowsInput<Row> = Readonly<{
  /** Whether results are drawn as cards; rows and calendars show every loaded row. */
  cards: boolean;
  /** The rows that match the search and tab, in list order. */
  rows: readonly Row[];
  searching: boolean;
  /** Whether the server has another page after the loaded ones. */
  hasNext: boolean;
  more: boolean;
  moreFailed: boolean;
  loading: boolean;
  /** Cards to keep showing after a restore (Back): the number that were shown. */
  floor: number;
  /** Told how many cards are shown, so a saved list can bring the same number back. */
  onShown: (count: number) => void;
  /** Read the next page. Callers may overlap; the reader ignores a read already in flight. */
  onMore: () => void;
}>;

/**
 * How many cards the grid shows. It shows whole rows of the measured grid, 18
 * cards at first (more when a row is wider), reading further pages until they
 * are loaded. "Show more" adds another 18 and reads pages only when the loaded
 * ones fall short. A search never reads on its own: it could walk the whole
 * catalogue. The last row is partial only when the results ran out.
 */
export function useCardRows<Row>({ cards, rows, searching, hasNext, more, moreFailed, loading, floor, onShown, onMore }: CardRowsInput<Row>) {
  const [gridRef, columns] = useGridColumns();
  const [wanted, setWanted] = useState(() => cardStep(columns));
  const limit = fullRows(Math.max(wanted, floor), columns);
  const filling = cards && !searching && !moreFailed && hasNext && rows.length < limit;
  const loadedRows = Math.floor(rows.length / columns) * columns;
  // While a page is on its way, hide a partial row rather than show it and fill it in.
  const shown = !cards ? rows : filling && loadedRows > 0 ? rows.slice(0, loadedRows) : rows.slice(0, limit);
  useEffect(() => {
    if (filling && !more && !loading) onMore();
  }, [filling, more, loading, onMore]);
  const count = shown.length;
  useEffect(() => onShown(count), [count, onShown]);
  function reveal() {
    if (!cards) return onMore();
    // A failed fill retries the rows already wanted; otherwise add a step.
    const next = rows.length < limit && hasNext ? limit : limit + cardStep(columns);
    setWanted(next);
    if (rows.length < next && hasNext) onMore();
  }
  return { gridRef, shown, reveal, canReveal: cards ? rows.length > shown.length || hasNext : hasNext };
}
