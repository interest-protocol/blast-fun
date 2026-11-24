import { HOME_ROWS_CHOICES } from "@blast/core/web/contracts/home.ts";

/**
 * How many coins a page of Home shows: the reader's choice on this device
 * (5, 10 or 20), kept in
 * the `blast.home.rows` cookie so the server's first page is already that
 * size. Never a server field, never in the URL. Anything the cookie holds
 * that is not such a count reads as the default.
 */
export const HOME_ROWS_DEFAULT = 10;
export const HOME_ROWS_COOKIE = "blast.home.rows";
export const HOME_ROWS_COOKIE_MAX_AGE_S = 365 * 24 * 3_600;

export function isHomeRows(value: unknown): value is number {
  return typeof value === "number" && (HOME_ROWS_CHOICES as readonly number[]).includes(value);
}

export function parseHomeRows(value: string | null | undefined, defaultRows = HOME_ROWS_DEFAULT): number {
  if (value === null || value === undefined || !/^[1-9][0-9]?$/.test(value)) return defaultRows;
  const rows = Number(value);
  return isHomeRows(rows) ? rows : defaultRows;
}

/** Whether a count is one of the Home choices. */
export function isRowsChoice(rows: number): rows is (typeof HOME_ROWS_CHOICES)[number] {
  return (HOME_ROWS_CHOICES as readonly number[]).includes(rows);
}

/** The cookie's value out of a `document.cookie` string (null when absent). */
export function homeRowsCookieValue(cookie: string): string | null {
  for (const part of cookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${HOME_ROWS_COOKIE}=`)) return trimmed.slice(HOME_ROWS_COOKIE.length + 1);
  }
  return null;
}

/** Store explicit choices, including the default, so later defaults cannot erase them. */
export function homeRowsCookieLine(rows: number, secure: boolean): string {
  const flags = `; Path=/; SameSite=Lax${secure ? "; Secure" : ""}`;
  return `${HOME_ROWS_COOKIE}=${rows}; Max-Age=${HOME_ROWS_COOKIE_MAX_AGE_S}${flags}`;
}
