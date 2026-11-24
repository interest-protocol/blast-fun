import { registerHooks } from "node:module";

/**
 * Tests only: lets `node --test` call a server component that reads the
 * request (`requestLaunchFlags`). Outside Next, `server-only` is an empty
 * marker and `next/headers` answers the headers set with `setRequestHeaders`.
 * Call `installRequestHeaders` before the page is imported (a dynamic import).
 */

const KEY = "blast.test.requestHeaders";
let installed = false;

export function installRequestHeaders(): void {
  if (installed) return;
  installed = true;
  const source = `export async function headers() { return new Headers(globalThis[Symbol.for(${JSON.stringify(KEY)})] ?? {}); }`;
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "server-only") return { url: "data:text/javascript,export {}", shortCircuit: true };
      if (specifier === "next/headers") return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
      return next(specifier, context);
    },
  });
}

/** The current request's headers, until the next call. */
export function setRequestHeaders(headers: Readonly<Record<string, string>>): void {
  (globalThis as Record<symbol, unknown>)[Symbol.for(KEY)] = { ...headers };
}

/** The current request's `Cookie` header, or none. */
export function setRequestCookie(cookie: string | null): void {
  setRequestHeaders(cookie === null ? {} : { cookie });
}
