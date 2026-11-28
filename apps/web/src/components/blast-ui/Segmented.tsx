"use client";

import clsx from "clsx";
import Link from "next/link";
import type { KeyboardEvent, ReactNode } from "react";

import { SegThumb } from "./SegThumb";

export type SegmentedOption<Key extends string | number | boolean> = readonly [key: Key, label: ReactNode];
export type SegmentedSize = "sm" | "md" | "chip" | "toolbar" | "touch";

type SegmentedProps<Key extends string | number | boolean> = Readonly<{
  label: string;
  options: readonly SegmentedOption<Key>[];
  value: Key;
  onChange: (key: Key) => void;
  /** A choice the trader is about to pick: a pointer rests on it, a finger lands on it, or it takes keyboard focus. */
  onIntent?: (key: Key) => void;
  /** A tablist with roving focus and arrow keys; otherwise a group of pressed buttons. */
  tabs?: boolean;
  /** `md` 38 (32px segments), `sm` 34, `chip` 36, `toolbar` 28, `touch` 44px targets for icon segments. */
  size?: SegmentedSize;
  variant?: "outline";
  /** Fill the container, each segment an equal share. */
  stretch?: boolean;
  /** Let labels in a stretched control wrap before the track needs to scroll. */
  wrap?: boolean;
  disabled?: boolean;
  /** One unavailable choice (an unsupported venue) stays visible but cannot be picked. */
  optionDisabled?: (key: Key) => boolean;
  /** As `tabs`: each tab's id and the id of the panel it controls, so the panel can be `aria-labelledby` its tab. */
  tabId?: (key: Key) => string;
  panelId?: (key: Key) => string;
  className?: string;
  id?: string;
}>;

/**
 * The one segmented control (`.seg`) for every page-level choice: a track
 * whose selected segment carries the neutral sliding thumb. Selection is
 * never the accent colour (BLAST-DESIGN-SYSTEM.md). Features pass the choice
 * and a callback; the track, thumb, sizes and keyboard model live here.
 */
export function Segmented<Key extends string | number | boolean>({
  label, options, value, onChange, onIntent, tabs = false, size = "md", variant, stretch = false, wrap = false, disabled = false, optionDisabled, tabId, panelId, className, id,
}: SegmentedProps<Key>) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!tabs) return;
    const open = options.map(([key]) => !(disabled || optionDisabled?.(key)));
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]")];
    // With no current tab (the shown choice lives outside the row), the arrows step from the focused tab.
    const current = options.findIndex(([key]) => key === value);
    const index = current === -1 ? buttons.indexOf(event.target as HTMLButtonElement) : current;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: 1, End: -1 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    // Walk to the next choice that can be picked, skipping unavailable ones; Home and End start from the ends.
    let next = event.key === "Home" ? -1 : event.key === "End" ? options.length : index;
    for (let tries = 0; tries < options.length; tries++) {
      next = (next + step + options.length) % options.length;
      if (open[next]) break;
    }
    if (!open[next] || next === current) return;
    onChange(options[next]![0]);
    buttons[next]?.focus();
  };
  const firstOpen = options.findIndex(([key]) => !(disabled || optionDisabled?.(key)));
  return (
    <div
      aria-label={label}
      className={clsx("seg", className)}
      data-size={size === "md" ? undefined : size}
      data-variant={variant}
      data-stretch={stretch || undefined}
      data-wrap={wrap || undefined}
      id={id}
      onKeyDown={onKeyDown}
      role={tabs ? "tablist" : "group"}
    >
      {options.map(([key, text], index) => {
        const on = key === value;
        // With no current tab (the shown choice lives outside the row), the first tab keeps the row in the Tab order.
        const entry = on || (index === firstOpen && !options.some(([option]) => option === value));
        const off = disabled || (optionDisabled?.(key) ?? false);
        const live = !on && !off;
        const intent = () => { if (live) onIntent?.(key); };
        return (
          <button
            aria-controls={tabs && panelId ? panelId(key) : undefined}
            aria-pressed={tabs ? undefined : on}
            aria-selected={tabs ? on : undefined}
            disabled={off}
            id={tabs && tabId ? tabId(key) : undefined}
            key={String(key)}
            onClick={() => { if (live) onChange(key); }}
            onFocus={intent}
            onPointerDown={intent}
            onPointerEnter={intent}
            role={tabs ? "tab" : undefined}
            tabIndex={tabs && !entry ? -1 : undefined}
            type="button"
          >
            {text}
          </button>
        );
      })}
      <SegThumb on={value} />
    </div>
  );
}

/**
 * The same control when each choice is a place: links with `aria-current`,
 * so the URL stays the source of truth and every segment can be opened in a
 * new tab. With `onNavigate`, a plain click or (as `tabs`) an arrow key
 * switches in place; modified clicks still open the link normally.
 */
export function SegmentedLinks({
  label, items, size = "md", stretch = false, className, id, tabs = false, onNavigate,
}: Readonly<{
  label: string;
  /** `id` and `controls` (the panel's id) let a tab panel be `aria-labelledby` its tab. */
  items: readonly Readonly<{ href: string; label: ReactNode; current: boolean; id?: string; controls?: string; onFocus?: () => void; onMouseEnter?: () => void; onNavigate?: () => void }>[];
  size?: SegmentedSize;
  /** Fill the container, each segment an equal share (labels may wrap). */
  stretch?: boolean;
  className?: string;
  id?: string;
  tabs?: boolean;
  onNavigate?: (index: number) => void;
}>) {
  const current = items.findIndex((item) => item.current);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!tabs) return;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : step === undefined ? null : (current + step + items.length) % items.length;
    if (next === null) return;
    event.preventDefault();
    const link = event.currentTarget.querySelectorAll<HTMLAnchorElement>("a")[next];
    // With onNavigate the switch happens in place; without it the arrow follows the link, so no tab is unreachable.
    if (onNavigate) onNavigate(next); else link?.click();
    link?.focus();
  };
  const Root = tabs ? "div" : "nav";
  return (
    <Root aria-label={label} className={clsx("seg", className)} data-size={size === "md" ? undefined : size} data-stretch={stretch || undefined} id={id} onKeyDown={onKeyDown} role={tabs ? "tablist" : undefined}>
      {items.map((item, index) => (
        <Link
          aria-controls={item.controls}
          aria-current={item.current ? "page" : undefined}
          aria-selected={tabs ? item.current : undefined}
          href={item.href}
          id={item.id}
          onFocus={item.onFocus}
          onMouseEnter={item.onMouseEnter}
          onNavigate={item.onNavigate}
          key={item.href}
          onClick={onNavigate ? (event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            if (!item.current) onNavigate(index);
          } : undefined}
          role={tabs ? "tab" : undefined}
          tabIndex={tabs && !item.current ? -1 : undefined}
        >
          {item.label}
        </Link>
      ))}
      <SegThumb on={current} />
    </Root>
  );
}
