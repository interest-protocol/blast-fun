import { readCsrfCookie } from "@blast/core/lib/web-security/csrf-contract.ts";

export function browserCsrfToken(): string | null {
  return typeof document === "undefined" ? null : readCsrfCookie(document.cookie);
}

