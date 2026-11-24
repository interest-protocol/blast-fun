"use client";

import { Button, DisclosureButton, IconButton, type ControlSize } from "#web/components/blast-ui/Button.tsx";
import { FilterMenu } from "#web/components/blast-ui/FilterMenu.tsx";
import { SelectField } from "#web/components/blast-ui/TextField.tsx";
import type { ReactNode } from "react";
import { Popover, PopoverSurface } from "#web/components/blast-ui/Popover.tsx";
import { BlastMenu, BlastMenuTrigger, BlastMenuRadioGroup, BlastMenuRadioItem, BlastMenuRadioItemIndicator } from "#web/components/blast-ui/BlastMenu.tsx";
import { Checkbox } from "#web/components/blast-ui/Checkbox.tsx";
import { SearchIcon } from "#web/components/blast-ui/Icons.tsx";
import { Segmented } from "#web/components/blast-ui/Segmented.tsx";
import { useShellActions } from "#web/components/blast-ui/shell-actions.tsx";

import { HOME_AGES, HOME_SORTS, HOME_ROWS_CHOICES, HOME_SOURCES, HOME_WINDOWS, type HomeSource } from "@blast/core/web/contracts/home.ts";

import styles from "./CoinHome.module.css";
import { HOME_SECTIONS_MENU_ID, type SectionChange } from "./HomeSections";
import { HOME_SECTIONS_DEFAULT, moveHomeSection, HOME_SECTION_TITLES, isHomeSectionShown, setHomeSectionShown, shownHomeSections, type HomeSectionPrefs } from "./home-sections";
import { AGE_LABELS, SORT_HINTS, SORT_LABELS, HOME_DEFAULT_FEED, MIN_PARTICIPANT_CHOICES, SOURCE_LABELS, WINDOW_LABELS, controlsApply, type HomeFeedState, type HomeViewState } from "./home-state";

const SOURCE_OPTIONS = HOME_SOURCES.map((key) => [key, SOURCE_LABELS[key]] as const);

/** The three sources as tabs (the brief's §5): the shared segmented tablist at the chip size (Main board: 36px beside the chips), arrow keys and Home/End move between them. */
export function SourceTabs({ source, onSource, ids }: Readonly<{ source: HomeSource; onSource: (source: HomeSource) => void; ids: (source: HomeSource) => string }>) {
  return <Segmented className={styles.sources} label="Coin sources" onChange={onSource} options={SOURCE_OPTIONS} panelId={ids} size="chip" tabId={(key) => `${ids(key)}-tab`} tabs value={source} />;
}

export function HomeSearch() {
  const run = useShellActions();
  return (
    <Button aria-haspopup="dialog" aria-keyshortcuts="/" className={styles.coinSearch} onClick={() => run("openSearch")} size="chip">
      <SearchIcon aria-hidden="true" />
      Search
      <span aria-hidden="true" className={styles.searchKey}>/</span>
    </Button>
  );
}

/** Shared anchored menu with keyboard navigation and viewport collision handling. */
export function Pick<Key extends string>({ label, value, options, labels, onPick, title, id, disabled, renderLabel, size = "sm" }: Readonly<{
  label: string;
  value: Key;
  options: readonly Key[];
  labels: Readonly<Record<Key, string>>;
  onPick: (key: Key) => void;
  title?: string;
  id?: string;
  disabled?: boolean;
  renderLabel?: (key: Key) => ReactNode;
  /** The trigger's shared size: `sm` (32) beside a table, `chip` (36, the Main board's toolbar) on a section's title line. */
  size?: ControlSize;
}>) {
  return <BlastMenu anchored className={styles.selectMenu} placement={() => ({ side: "bottom", align: "start", sideOffset: 6, avoid: "flip", originX: "18px" })} label={label} trigger={<BlastMenuTrigger render={<DisclosureButton size={size}>{renderLabel ? renderLabel(value) : labels[value]}</DisclosureButton>} id={id} disabled={disabled} title={title} aria-label={`${label}: ${labels[value]}`} />}>
    <BlastMenuRadioGroup value={value} onValueChange={(next) => onPick(next as Key)}>
      {options.map((key) => <BlastMenuRadioItem closeOnClick className={styles.selectOption} value={key} key={key}>{renderLabel ? renderLabel(key) : labels[key]}<BlastMenuRadioItemIndicator> ✓</BlastMenuRadioItemIndicator></BlastMenuRadioItem>)}
    </BlastMenuRadioGroup>
  </BlastMenu>;
}

type ViewProps = Readonly<{ state: HomeFeedState; onChange: (next: HomeFeedState) => void }>;

/** The window (1h, 24h), which applies to every section. */
export function WindowPick({ state, onChange, size }: Readonly<{ state: HomeViewState; onChange: (next: HomeViewState) => void; size?: ControlSize }>) {
  return <Pick label="Activity window" labels={WINDOW_LABELS} onPick={(window) => onChange({ ...state, window })} options={HOME_WINDOWS} size={size} value={state.window} />;
}

/** Customize Home's glyph (the Main board's sliders), the chip's 18px, in the current colour. */
function SlidersIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="18" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" viewBox="0 0 24 24" width="18">
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </svg>
  );
}

/** The three supported page sizes, kept beside their table. */
export function RowsPick({ rows, onRows, what = "coins" }: Readonly<{ rows: number; onRows: (rows: number) => void; what?: string }>) {
  return <span className={styles.rows}><Pick label={`${what[0]!.toUpperCase()}${what.slice(1)} rows per page`} labels={{ "5": "5 per page", "10": "10 per page", "20": "20 per page" }} options={HOME_ROWS_CHOICES.map(String)} value={String(rows)} onPick={(key) => onRows(Number(key))} /></span>;
}

/** Customize Home: a gear in the page header; its popover's title counts the hidden sections above their visibility and order. */
export function HomeSettingsMenu({ sections, onSections, showLabel }: Readonly<{ sections: HomeSectionPrefs; onSections: (next: HomeSectionPrefs, change: SectionChange | null) => void; showLabel: boolean }>) {
  const available = sections.order;
  const visible = shownHomeSections(sections);
  const hiddenCount = available.length - visible.length;
  return <Popover.Root>
    <Popover.Trigger
      id={HOME_SECTIONS_MENU_ID}
      render={showLabel
        ? <Button size="lg" variant="ghost">Customize Home</Button>
        : <IconButton aria-label="Customize Home" size="chip" title="Customize Home" variant="secondary"><SlidersIcon /></IconButton>}
    />
    <PopoverSurface
      positioner={{ sideOffset: 8, align: "end", collisionPadding: 12, className: styles.settingsLayer }}
      popup={{ className: styles.sectionsMenu }}
    >
          <Popover.Title className={styles.menuLabel}>Sections{hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ""}</Popover.Title>
          {available.map((key) => {
            const shown = isHomeSectionShown(sections, key);
            const position = visible.indexOf(key);
            return <div className={styles.sectionRow} key={key}>
              <label><Checkbox checked={shown} onChange={(event) => onSections(setHomeSectionShown(sections, key, event.target.checked), { key, action: event.target.checked ? "show" : "hide", position })} />{HOME_SECTION_TITLES[key]}</label>
              <IconButton aria-label={`Move ${HOME_SECTION_TITLES[key]} up`} disabled={!shown || position === 0} onClick={() => onSections(moveHomeSection(sections, key, -1), { key, action: "move", position: position - 1 })} size="sm">↑</IconButton>
              <IconButton aria-label={`Move ${HOME_SECTION_TITLES[key]} down`} disabled={!shown || position === visible.length - 1} onClick={() => onSections(moveHomeSection(sections, key, 1), { key, action: "move", position: position + 1 })} size="sm">↓</IconButton>
            </div>;
          })}
          <Button onClick={() => onSections(HOME_SECTIONS_DEFAULT, null)} size="sm">Restore defaults</Button>
        </PopoverSurface>
  </Popover.Root>;
}

export function CoinsListControls({ state, onChange }: ViewProps) {
  const discover = controlsApply(state.source);
  const mixed = discover && state.sort === "mixed";
  const changed = !mixed && (discover || state.window !== HOME_DEFAULT_FEED.window);
  const label = ["Filters", discover ? SORT_LABELS[state.sort] : null, mixed ? null : WINDOW_LABELS[state.window], changed ? "active" : null].filter(Boolean).join(", ");
  return <FilterMenu active={changed} label={label}>
    {discover ? <label>View<SelectField aria-label="View" value={state.sort} onChange={event => {
      const sort = event.target.value as HomeFeedState["sort"];
      onChange(sort === "mixed" ? HOME_DEFAULT_FEED : { ...state, sort });
    }}>
      <option value="mixed">{SORT_LABELS.mixed}</option>
      {HOME_SORTS.map(key => <option key={key} title={SORT_HINTS[key]} value={key}>{SORT_LABELS[key]}</option>)}
    </SelectField></label> : null}
    {!mixed ? <label>Activity window<SelectField aria-label="Activity window" value={state.window} onChange={event => onChange({ ...state, window: event.target.value as HomeFeedState["window"] })}>
      {HOME_WINDOWS.map(key => <option key={key} value={key}>{WINDOW_LABELS[key]}</option>)}
    </SelectField></label> : null}
    {discover && !mixed ? <>
      <label>Participants<SelectField aria-label="Participants" value={state.minParticipants} onChange={event => onChange({ ...state, minParticipants: Number(event.target.value) })}>
        {MIN_PARTICIPANT_CHOICES.map(value => <option key={value} value={value}>{value ? `${value} or more` : "Any"}</option>)}
      </SelectField></label>
      <label>Launched<SelectField aria-label="Launched" value={state.age} onChange={event => onChange({ ...state, age: event.target.value as HomeFeedState["age"] })}>
        {HOME_AGES.map(key => <option key={key} value={key}>{AGE_LABELS[key]}</option>)}
      </SelectField></label>
      <label><Checkbox checked={state.tradable} onChange={event => onChange({ ...state, tradable: event.target.checked })} />Trades in the app only</label>
    </> : null}
    {changed ? <Button onClick={() => onChange(discover ? HOME_DEFAULT_FEED : { ...state, window: HOME_DEFAULT_FEED.window })} size="sm">Reset filters</Button> : null}
  </FilterMenu>;
}
