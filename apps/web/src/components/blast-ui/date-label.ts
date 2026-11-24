const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "2-digit", timeZone: "UTC" });
const localDate = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const localTime = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export function shortUtcDate(date: Date): string {
  return day.format(date).replace(/ (\d{2})$/, " ’$1");
}

export function tradeTimeLabel(at: number, localDay: number): string | undefined {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return undefined;

  const today = new Date(localDay);
  const yesterday = new Date(localDay);
  yesterday.setDate(yesterday.getDate() - 1);

  const time = localTime.format(date);
  if (date.toDateString() === today.toDateString()) return `Today ${time}`;
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;

  const year = date.getFullYear() < today.getFullYear() ? ` ${date.getFullYear()}` : "";
  return `${localDate.format(date)}${year} ${time}`;
}
