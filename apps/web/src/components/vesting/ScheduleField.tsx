"use client";

import { useState } from "react";
import { DayPicker } from "react-day-picker";
import { Popover, PopoverSurface } from "#web/components/blast-ui/Popover.tsx";
import { TextField } from "#web/components/blast-ui/TextField.tsx";
import styles from "./ScheduleField.module.css";
import { wallInstants, zonedString } from "./zoned-time";

const dayText = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** "YYYY-MM-DD" as the browser-local midnight the calendar works in, or undefined. */
function calendarDay(date: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return undefined;
  const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return day.getDate() === Number(match[3]) ? day : undefined;
}

function dateText(day: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${String(day.getFullYear()).padStart(4, "0")}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

function TimezoneNote({ id, timezone }: Readonly<{ id: string; timezone: string }>) {
  return <p className={timezone === "UTC" ? "sr" : styles.timezone} id={`${id}-timezone`}>{timezone}</p>;
}

export function ScheduleField({
  id,
  label,
  value,
  onChange,
  onBlur,
  error,
  timezone,
}: Readonly<{
  id: string;
  label: string;
  value: string;
  onChange(value: string): void;
  onBlur(): void;
  error?: string;
  timezone: string;
}>) {
  const [open, setOpen] = useState(false);
  const timeLabel = label.replace(/date$/i, "time");
  const describedBy = `${id}-timezone${error ? ` ${id}-error` : ""}`;
  // The value is "date", "dateTtime" or a zoned string; only its wall date and minute are edited.
  const split = value.indexOf("T");
  const date = split < 0 ? value : value.slice(0, split);
  const time = split < 0 ? "12:00" : value.slice(split + 1, split + 6);
  const selected = calendarDay(date);
  let choices: string[] = [];
  try {
    const instants = wallInstants(`${date}T${time}`, timezone);
    if (instants.length === 2)
      choices = instants.map((instant) => zonedString(instant, timezone));
  } catch {
    /* The field validator supplies the actionable message. */
  }
  const year = new Date().getFullYear();
  return (
    <div className={styles.field} onBlur={onBlur}>
      <div className={styles.date}>
        <label htmlFor={id} id={`${id}-label`}>{label}</label>
        <Popover.Root open={open} onOpenChange={setOpen}>
          <Popover.Trigger
            id={id}
            className={styles.trigger}
            aria-labelledby={`${id}-label ${id}-value`}
            aria-describedby={describedBy}
            aria-invalid={!!error || undefined}
          >
            <span id={`${id}-value`} data-placeholder={selected ? undefined : ""}>
              {selected
                ? dayText.format(Date.UTC(selected.getFullYear(), selected.getMonth(), selected.getDate()))
                : "Choose date"}
            </span>
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <rect x="3" y="5" width="18" height="16" rx="3" />
              <path d="M7 3v4m10-4v4M3 11h18" />
            </svg>
          </Popover.Trigger>
          <PopoverSurface
            positioner={{ align: "start", className: styles.positioner, collisionPadding: 12, side: "bottom", sideOffset: 6 }}
            popup={{ className: styles.popover, "aria-label": `Choose ${label}` }}
          >
            <DayPicker
              mode="single"
              autoFocus
              selected={selected}
              defaultMonth={selected}
              onSelect={(day) => {
                if (day) onChange(`${dateText(day)}T${time || "12:00"}`);
                setOpen(false);
              }}
              weekStartsOn={1}
              captionLayout="dropdown"
              startMonth={new Date(Math.min(year - 1, selected?.getFullYear() ?? year), 0)}
              endMonth={new Date(Math.max(year + 100, selected?.getFullYear() ?? year), 11)}
              classNames={{
                root: styles.calendar,
                months: styles.months,
                month: styles.month,
                month_caption: styles.caption,
                dropdowns: styles.dropdowns,
                dropdown_root: styles.dropdownRoot,
                dropdown: styles.dropdown,
                caption_label: styles.captionLabel,
                nav: styles.nav,
                button_previous: styles.navButton,
                button_next: styles.navButton,
                chevron: styles.chevron,
                month_grid: styles.grid,
                weekdays: styles.weekdays,
                weekday: styles.weekday,
                week: styles.week,
                day: styles.day,
                day_button: styles.dayButton,
                selected: styles.selected,
                today: styles.today,
                outside: styles.outside,
                disabled: styles.disabled,
                hidden: styles.hidden,
              }}
            />
          </PopoverSurface>
        </Popover.Root>
      </div>
      <label className={styles.time}>
        {timeLabel}
        <TextField
          size="lg"
          type="time"
          id={`${id}-time`}
          value={time}
          onChange={(event) => onChange(`${date}T${event.currentTarget.value}`)}
          aria-invalid={!!error || undefined}
          aria-describedby={describedBy}
        />
      </label>
      <TimezoneNote id={id} timezone={timezone} />
      {choices.length ? (
        <div
          className={styles.occurrences}
          role="group"
          aria-label="Choose daylight-saving occurrence"
        >
          <span>This time occurs twice. Choose its UTC offset:</span>
          {choices.map((choice, index) => (
            <button
              type="button"
              key={choice}
              aria-pressed={value === choice}
              className="btn btn-line btn-sm"
              onClick={() => onChange(choice)}
            >
              {index === 0 ? "First" : "Second"} · UTC
              {choice.split("[")[0]!.slice(-6)}
            </button>
          ))}
        </div>
      ) : null}
      {error ? (
        <span className={styles.error} id={`${id}-error`}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
