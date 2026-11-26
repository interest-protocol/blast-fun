/**
 * Wall-clock times in an IANA zone, with Intl only. A wall time can match no instant
 * (a daylight-saving gap), one, or two (an overlap); callers decide what to do with each.
 */
const WALL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?$/;
const ZONED = /^(.+?)(Z|[+-]\d{2}:\d{2})?\[([^\]]+)\]$/;
const DAY_MS = 86_400_000;

function utcMs(fields: readonly number[]): number {
  const [year, month, day, hour, minute, second, ms] = fields as [number, number, number, number, number, number, number];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, ms);
  return date.getTime();
}

/** The wall time as if it were UTC, or null when it is not a real calendar time. */
function wallMs(text: string): number | null {
  const match = WALL.exec(text);
  if (!match) return null;
  const fields = match.slice(1).map((part, index) =>
    index === 6 ? Number((part ?? "").padEnd(3, "0")) : Number(part ?? 0),
  );
  const ms = utcMs(fields);
  const date = new Date(ms);
  const real =
    date.getUTCFullYear() === fields[0] &&
    date.getUTCMonth() + 1 === fields[1] &&
    date.getUTCDate() === fields[2] &&
    date.getUTCHours() === fields[3] &&
    date.getUTCMinutes() === fields[4] &&
    date.getUTCSeconds() === fields[5];
  return real ? ms : null;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The zone's UTC offset at an instant: wall time minus instant, in milliseconds. */
function offsetMs(instant: number, timeZone: string): number {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      era: "short",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    });
    formatters.set(timeZone, format);
  }
  const part: Record<string, string> = {};
  for (const { type, value } of format.formatToParts(instant)) part[type] = value;
  const year = Number(part.year);
  const whole = Math.floor(instant / 1000) * 1000;
  const wall = utcMs([
    part.era === "BC" ? 1 - year : year,
    Number(part.month),
    Number(part.day),
    Number(part.hour),
    Number(part.minute),
    Number(part.second),
    0,
  ]);
  return wall - whole;
}

/** Every instant whose wall time in `timeZone` is `wall`, earliest first. Throws on an unknown zone. */
export function wallInstants(wall: string, timeZone: string): readonly number[] {
  const local = wallMs(wall);
  if (local === null) return [];
  const offsets = new Set(
    [local - DAY_MS, local, local + DAY_MS].map((at) => offsetMs(at, timeZone)),
  );
  return [...offsets]
    .map((offset) => local - offset)
    .filter((instant) => offsetMs(instant, timeZone) === local - instant)
    .sort((a, b) => a - b);
}

/** An instant from "wall[offset][Zone]"; a missing offset must leave exactly one instant. */
export function zonedInstant(text: string): number | null {
  const match = ZONED.exec(text);
  if (!match) return null;
  const [, wall, offset, timeZone] = match as unknown as [string, string, string | undefined, string];
  const instants = wallInstants(wall, timeZone);
  if (offset === undefined) return instants.length === 1 ? instants[0]! : null;
  const sign = offset.startsWith("-") ? -1 : 1;
  const minutes = offset === "Z" ? 0 : sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
  const local = wallMs(wall)!;
  return instants.find((instant) => Math.round((local - instant) / 60_000) === minutes) ?? null;
}

function pad(value: number, length = 2): string {
  return String(Math.abs(value)).padStart(length, "0");
}

/** "2030-03-10T13:00:00-04:00[America/New_York]": the wall time, its UTC offset and its zone. */
export function zonedString(instant: number, timeZone: string): string {
  const offset = offsetMs(instant, timeZone);
  const wall = new Date(instant + offset);
  const year = wall.getUTCFullYear();
  const ms = wall.getUTCMilliseconds();
  const offsetMinutes = Math.round(offset / 60_000);
  return (
    `${year < 0 || year > 9999 ? `${year < 0 ? "-" : "+"}${pad(year, 6)}` : pad(year, 4)}` +
    `-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}` +
    `T${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}:${pad(wall.getUTCSeconds())}` +
    `${ms ? `.${pad(ms, 3)}` : ""}` +
    `${offsetMinutes < 0 ? "-" : "+"}${pad(Math.trunc(offsetMinutes / 60))}:${pad(offsetMinutes % 60)}` +
    `[${timeZone}]`
  );
}
