import { CSRF_HEADER_NAME, readCsrfCookie } from "@blast/core/lib/web-security/csrf-contract.ts";

export function browserCsrfToken(): string | null {
  return typeof document === "undefined" ? null : readCsrfCookie(document.cookie);
}

export function browserCsrfHeaders(): Record<string, string> {
  const token = browserCsrfToken();
  return token ? { [CSRF_HEADER_NAME]: token } : {};
}
