const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "2-digit", timeZone: "UTC" });

export function shortUtcDate(date: Date): string {
  return day.format(date).replace(/ (\d{2})$/, " ’$1");
}
