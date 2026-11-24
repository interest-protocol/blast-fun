export const CSRF_COOKIE_NAME = "__Host-blast_csrf";
export const CSRF_HEADER_NAME = "x-blast-csrf";

export function readCsrfCookie(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    if (part.slice(0, index).trim() === CSRF_COOKIE_NAME) {
      return part.slice(index + 1).trim();
    }
  }
  return null;
}
