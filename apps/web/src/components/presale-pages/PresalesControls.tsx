"use client";

import { FilterMenu } from "#web/components/blast-ui/FilterMenu.tsx";
import { Tabs } from "@base-ui/react/tabs";
import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import { PageHeader } from "#web/components/blast-ui/PageHeader.tsx";
import { GridIcon, SearchIcon } from "#web/components/blast-ui/Icons.tsx";
import { Button } from "#web/components/blast-ui/Button.tsx";
import { FieldGroup, SelectField, TextField } from "#web/components/blast-ui/TextField.tsx";
import { Segmented } from "#web/components/blast-ui/Segmented.tsx";
import { usePhoneLayout } from "#web/components/blast-ui/use-shell-prefs.ts";
import { cx } from "./cx";
import { RowsIcon, StarIcon } from "./icons";
import { discoverySorts, type PresaleScope } from "./discovery-state";
import type { PresaleListView, PresaleResultLayout } from "./PresalesList";

const VIEWS = [
  ["live", "Live"],
  ["upcoming", "Upcoming"],
  ["ended", "Ended"],
] as const;

const PAGE_VIEWS = [["list", "Browse"], ["calendar", "Calendar"], ["backed", "Backed"]] as const;

// Icon segments keep their names as text, so each button is still announced.
const LAYOUTS = [
  ["cards", <><GridIcon /><span className="sr-only">Cards</span></>],
  ["list", <><RowsIcon /><span className="sr-only">List</span></>],
] as const;

/**
 * Presales discovery keeps the status controls ahead of featured sales.
 * The status tabs retain Base UI's tab semantics and panels.
 */
export function PresalesControls({
  status,
  sort,
  view,
  layout = "cards",
  onLayout,
  watchlist = true,
  scope = "all",
  onScope,
  search = "",
  onSearch,
  showResultControls = true,
  featured,
  children,
  onView,
  onChoose,
}: Readonly<{
  status: "live" | "upcoming" | "ended";
  sort: string;
  view: PresaleListView;
  layout?: PresaleResultLayout;
  onLayout?: (layout: PresaleResultLayout) => void;
  watchlist?: boolean;
  scope?: PresaleScope;
  onScope?: (scope: PresaleScope, event?: MouseEvent) => void;
  search?: string;
  onSearch?: (search: string) => void;
  showResultControls?: boolean;
  featured?: ReactNode;
  children?: ReactNode;
  onView?: (view: PresaleListView) => void;
  onChoose?: (
    status: "live" | "upcoming" | "ended",
    sort: string,
    event?: MouseEvent,
  ) => void;
}>) {
  const phone = usePhoneLayout();
  const selected = view === "calendar" ? "upcoming" : status;
  const tabList = useActivePresaleTab(selected, view);
  return (
    <Tabs.Root
      className={cx("presale-discovery")}
      data-presale-browse=""
      value={selected}
      onValueChange={(key: unknown) => {
        if (key === "live" || key === "upcoming" || key === "ended")
          onChoose?.(key, discoverySorts(key, scope)[0][0]);
      }}
    >
      <PageHeader
        title="Presales"
        actions={
          <div className={cx("presale-layout")}>
            <Segmented
              className={cx("list-view")}
              disabled={!onView}
              label="View"
              onChange={(key) => onView?.(key)}
              options={PAGE_VIEWS}
              value={view}
            />
          </div>
        }
      />
      {view === "list" ? (
        <div className={cx("presale-controls")}>
          <Tabs.List
            activateOnFocus={false}
            aria-label="Presale views"
            className={cx("presale-views")}
            ref={tabList}
          >
            {VIEWS.map(([key, label]) => <PresaleStatusTab key={key} value={key} label={label} canChoose={!!onChoose} />)}
            <Tabs.Indicator className={cx("presale-view-ind")} data-tab-indicator="" />
          </Tabs.List>
          {onSearch ? (
            <FieldGroup className={cx("catalog-search")}>
              <SearchIcon />
              <TextField aria-label="Search presales by name, ticker or address" onChange={event => onSearch(event.target.value)} placeholder="Search presales" type="search" value={search} />
            </FieldGroup>
          ) : null}
          {(watchlist || showResultControls) && (
            <div className={cx("catalog-tools")}>
              <PresaleDiscoveryToolbar showResultControls={showResultControls} status={status} sort={sort} watchlist={watchlist} scope={scope} onScope={onScope} onChoose={onChoose} layout={layout} onLayout={onLayout} phone={phone} />
              {showResultControls && !phone ? <Segmented
                className={cx("result-layout")}
                disabled={!onLayout}
                label="Result layout"
                onChange={(key) => onLayout?.(key)}
                options={LAYOUTS}
                value={layout}
              /> : null}
            </div>
          )}
        </div>
      ) : null}
      {view === "list" ? featured : null}
      <PresalePanels selected={selected} view={view} scope={scope} status={status} onScope={onScope}>{children}</PresalePanels>
    </Tabs.Root>
  );
}

function PresalePanels({ selected, view, scope, status, onScope, children }: Readonly<{
  selected: string;
  view: PresaleListView;
  scope: PresaleScope;
  status: string;
  onScope?: (scope: PresaleScope, event?: MouseEvent) => void;
  children?: ReactNode;
}>) {
  if (view === "calendar" || view === "backed") return children;
  return VIEWS.map(([key]) => (
    <Tabs.Panel className={cx("presale-panel")} hidden={key !== selected} keepMounted key={key} value={key}>
      {key === selected ? <>
        <LegacyScopeNotice view={view} scope={scope} status={status} onScope={onScope} />
        {children}
      </> : null}
    </Tabs.Panel>
  ));
}

function useActivePresaleTab(selected: string, view: PresaleListView) {
  const tabList = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = tabList.current;
    if (!list) return;
    const revealActive = () => {
      const active = list.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!active) return;
      const row = list.getBoundingClientRect();
      const tab = active.getBoundingClientRect();
      // Scroll only the tab row; restoring a section must not move the page.
      if (tab.left < row.left) list.scrollLeft += tab.left - row.left;
      else if (tab.right > row.right) list.scrollLeft += tab.right - row.right;
    };
    revealActive();
    const observer = new ResizeObserver(revealActive);
    observer.observe(list);
    return () => observer.disconnect();
  }, [selected, view]);
  return tabList;
}

function PresaleStatusTab({ value, label, canChoose }: Readonly<{
  value: typeof VIEWS[number][0]; label: ReactNode; canChoose: boolean;
}>) {
  return <Tabs.Tab className={cx("presale-view")} disabled={!canChoose} value={value}>
    {label}
  </Tabs.Tab>;
}

function LegacyScopeNotice({ view, scope, status, onScope }: Readonly<{
  view: PresaleListView; scope: PresaleScope; status: string;
  onScope?: (scope: PresaleScope, event?: MouseEvent) => void;
}>) {
  if (view !== "list" || scope !== "following") return null;
  return <div className={cx("legacy-scope")}>
    <span>Showing presales backed by people you follow from your saved link.</span>
    <Button disabled={!onScope} onClick={(event) => onScope?.("all", event)} size="sm" variant="ghost">Show all {status} presales</Button>
  </div>;
}

function PresaleDiscoveryToolbar({ status, sort, watchlist, scope = "all", onScope, onChoose, showResultControls, layout, onLayout, phone }: Pick<Parameters<typeof PresalesControls>[0], "status" | "sort" | "watchlist" | "scope" | "onScope" | "onChoose" | "showResultControls" | "layout" | "onLayout"> & { phone: boolean }) {
  if (!watchlist && !showResultControls) return null;
  const sorts = discoverySorts(status, scope);
  const sortLabel = sorts.find(([value]) => value === sort)?.[1] ?? sorts[0][1];
  const active = scope !== "all" || sort !== sorts[0][0] || (phone && layout === "list");
  return <FilterMenu active={active} label={`Filters, ${sortLabel}${scope === "watch" ? ", Watchlist" : ""}`}>
    {showResultControls ? <label>Sort<SelectField aria-label="Sort" disabled={!onChoose} onChange={event => onChoose?.(status, event.target.value)} value={sort}>
      {sorts.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </SelectField></label> : null}
    {watchlist ? <Button aria-pressed={scope === "watch"} disabled={!onScope} onClick={event => onScope?.(scope === "watch" ? "all" : "watch", event)}><StarIcon />Watchlist only</Button> : null}
    {phone && showResultControls ? <label>Result layout<SelectField aria-label="Result layout" disabled={!onLayout} value={layout} onChange={event => onLayout?.(event.target.value as PresaleResultLayout)}>
      <option value="cards">Cards</option><option value="list">List</option>
    </SelectField></label> : null}
  </FilterMenu>;
}
