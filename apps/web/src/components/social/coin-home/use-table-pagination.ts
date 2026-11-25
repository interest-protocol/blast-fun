"use client";

import { readBrowserStorage, writeBrowserStorage } from "#web/lib/browser-storage.ts";
import { useState, useSyncExternalStore } from "react";
import { deviceStore } from "#web/components/ui-libraries/device-store.ts";
import { parseHomeRows } from "./home-rows";

type Table = "traders" | "posts";
const TABLE_ROWS_DEFAULT = 5;
const storageKey = (table: Table) => `blast.home.${table}.rows`;
const rowStore = (table: Table) => deviceStore(() => {
  return parseHomeRows(readBrowserStorage("local", storageKey(table)), TABLE_ROWS_DEFAULT);
});
const stores = { traders: rowStore("traders"), posts: rowStore("posts") };

/** Shared row preference and page selection for local and server-paged Home tables. */
export function useTablePage(table: Table, scope: string) {
  const store = stores[table];
  const rows = useSyncExternalStore(store.subscribe, store.get, () => TABLE_ROWS_DEFAULT);
  const [selection, setSelection] = useState({ page: 1, scope, rows });
  const page = selection.scope === scope && selection.rows === rows ? selection.page : 1;
  const onPage = (next: number) => setSelection({ page: Math.max(1, next), scope, rows });
  const onRows = (next: number) => {
    const value = parseHomeRows(String(next), TABLE_ROWS_DEFAULT);
    writeBrowserStorage("local", storageKey(table), String(value));
    store.set(value);
    setSelection({ page: 1, scope, rows: value });
  };
  return { rows, page, onRows, onPage };
}

/** Page one on a new activity window or row count; clamp immediately after live removals. */
export function useTablePagination(table: Table, total: number, scope: string, hasMore = false) {
  const selection = useTablePage(table, scope);
  const pages = Math.max(1, Math.ceil(total / selection.rows) + (hasMore ? 1 : 0));
  const page = Math.min(selection.page, pages);
  return { ...selection, page, pages, start: (page - 1) * selection.rows,
    onPage: (next: number) => selection.onPage(Math.min(next, pages)) };
}
