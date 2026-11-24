import { useId, type Key, type ReactNode } from "react";

import styles from "./primitives.module.css";

export type DataTableColumn<Row> = Readonly<{
  header: string;
  /** Right-aligns the column with tabular figures. */
  numeric?: boolean;
  cell: (row: Row) => ReactNode;
}>;

/**
 * An accessible table of facts, also the text equivalent of any chart. The
 * first column heads each row. Callers show Loading/Empty/Unavailable through
 * DataState rather than an empty table.
 */
export function DataTable<Row>({
  caption,
  captionHidden = false,
  columns,
  rows,
  rowKey,
  rowAnchor,
}: Readonly<{
  caption: string;
  captionHidden?: boolean;
  columns: readonly DataTableColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => Key;
  /** A row's fragment id, and whether it is the record a link targets (`aria-current`). */
  rowAnchor?: (row: Row) => Readonly<{ id: string; current: boolean }>;
}>) {
  const captionId = useId();
  const [first, ...rest] = columns;
  return (
    // Narrow screens scroll the table sideways; the region is focusable so keyboards can too.
    <div className={styles.tableScroll} role="region" aria-labelledby={captionId} tabIndex={0}>
      <table className={styles.table}>
        <caption id={captionId} className={captionHidden ? styles.srOnly : styles.caption}>
          {caption}
        </caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.header} scope="col" data-numeric={column.numeric || undefined}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const anchor = rowAnchor?.(row);
            return (
              <tr key={rowKey(row)} id={anchor?.id} aria-current={anchor?.current ? "true" : undefined}>
                <th scope="row" data-numeric={first.numeric || undefined}>{first.cell(row)}</th>
                {rest.map((column) => (
                  <td key={column.header} data-numeric={column.numeric || undefined}>
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
