/** Preload only in disposable physical fixtures: unexpected provider calls fail before DNS. */
import pg from "pg";

const query = pg.Client.prototype.query;
Reflect.set(pg.Client.prototype, "query", function (this: unknown, ...args: unknown[]) {
  const result = Reflect.apply(query, this, args) as unknown;
  if (!(result instanceof Promise)) {
    return result;
  }
  return result.catch((error: unknown) => {
    const code = error && typeof error === "object" ? Reflect.get(error, "code") : undefined;
    console.error(
      "fixture_sql_failure",
      typeof code === "string" && /^[A-Z0-9]{5}$/.test(code) ? code : "unknown",
    );
    throw error;
  });
});

const transport = globalThis.fetch;
globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    return Promise.reject(new Error("Physical fixture refused a non-loopback fetch."));
  }
  return transport(input, init);
}, transport);

export {};
