"use client";

import {
  Button,
  Calendar,
  CalendarCell,
  CalendarGrid,
  CalendarGridBody,
  CalendarGridHeader,
  CalendarHeaderCell,
  DateInput,
  DatePicker,
  DateSegment,
  type DateSegmentProps,
  Dialog,
  Group,
  Heading,
  I18nProvider,
  Label,
  Popover,
  TimeField,
} from "react-aria-components";
import {
  parseDate,
  parseDateTime,
  parseTime,
  toZoned,
} from "@internationalized/date";
import { usePortalContainer } from "#web/components/ui-libraries/portal.ts";
import styles from "./ScheduleField.module.css";

const monthName = new Intl.DateTimeFormat("en-GB", {
  month: "short",
  timeZone: "UTC",
});

function dateSegmentText(segment: DateSegmentProps["segment"]) {
  if (segment.type === "literal") return " ";
  if (segment.type !== "month") return segment.text;
  if (segment.isPlaceholder || !segment.value) return "mmm";
  return monthName.format(new Date(Date.UTC(2000, segment.value - 1, 1)));
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
  const portalContainer = usePortalContainer();
  const timeLabel = label.replace(/date$/i, "time");
  const describedBy = `${id}-timezone${error ? ` ${id}-error` : ""}`;
  const wall = value.slice(0, 16);
  const [date = "", time = "12:00"] = wall.split("T");
  let parsed = null;
  try {
    if (date) parsed = parseDate(date);
  } catch {
    /* Keep incomplete entry editable. */
  }
  let parsedTime = null;
  try {
    if (time) parsedTime = parseTime(time);
  } catch {
    /* Keep incomplete entry editable. */
  }
  let choices: string[] = [];
  try {
    const local = parseDateTime(wall);
    const first = toZoned(local, timezone, "earlier");
    const last = toZoned(local, timezone, "later");
    if (
      first.toString() !== last.toString() &&
      first.toDate().getTime() !== last.toDate().getTime() &&
      first.hour === local.hour &&
      last.hour === local.hour
    ) {
      choices = [first.toString(), last.toString()];
    }
  } catch {
    /* The field validator supplies the actionable message. */
  }
  return (
    <I18nProvider locale="en-GB">
      <div className={styles.field} onBlur={onBlur}>
        <DatePicker
          className={styles.date}
          value={parsed}
          onChange={(next) =>
            onChange(next ? `${next}T${time || "12:00"}` : "")
          }
          isInvalid={!!error}
          validationBehavior="aria"
          aria-describedby={describedBy}
        >
          <Label>{label}</Label>
          <Group
            className={styles.dateGroup}
            id={id}
            tabIndex={-1}
            aria-describedby={error ? `${id}-error` : undefined}
          >
            <DateInput className={styles.dateInput}>
              {(segment) => (
                <DateSegment segment={segment} className={styles.segment}>
                  {dateSegmentText(segment)}
                </DateSegment>
              )}
            </DateInput>
            <Button
              className={styles.trigger}
              aria-label={`Open calendar for ${label}`}
            >
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
            </Button>
          </Group>
          <Popover
            UNSTABLE_portalContainer={portalContainer ?? undefined}
            className={styles.popover}
            placement="bottom start"
            containerPadding={12}
          >
            <Dialog aria-label={`Choose ${label}`}>
              <Calendar>
                <header className={styles.header}>
                  <Button slot="previous" aria-label="Previous month">
                    ‹
                  </Button>
                  <Heading />
                  <Button slot="next" aria-label="Next month">
                    ›
                  </Button>
                </header>
                <CalendarGrid className={styles.calendar}>
                  <CalendarGridHeader>
                    {(day) => <CalendarHeaderCell>{day}</CalendarHeaderCell>}
                  </CalendarGridHeader>
                  <CalendarGridBody>
                    {(day) => (
                      <CalendarCell date={day} className={styles.day} />
                    )}
                  </CalendarGridBody>
                </CalendarGrid>
              </Calendar>
            </Dialog>
          </Popover>
        </DatePicker>
        <TimeField
          className={styles.time}
          value={parsedTime}
          onChange={(next) =>
            onChange(`${date}T${next?.toString().slice(0, 5) ?? ""}`)
          }
          hourCycle={24}
          granularity="minute"
          isInvalid={!!error}
          validationBehavior="aria"
          aria-describedby={describedBy}
        >
          <Label>{timeLabel}</Label>
          <Group className={styles.dateGroup}>
            <DateInput className={styles.dateInput} aria-label={timeLabel}>
              {(segment) => (
                <DateSegment segment={segment} className={styles.segment} />
              )}
            </DateInput>
          </Group>
        </TimeField>
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
    </I18nProvider>
  );
}
