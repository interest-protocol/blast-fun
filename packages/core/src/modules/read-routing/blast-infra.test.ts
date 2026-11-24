import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  BLAST_INFRA_KEY_HEADER,
  blastInfraApiKey,
  blastInfraFetch,
  defaultMarketDataDependencies,
  marketDataOrigin,
} from "./blast-infra.ts";

const KEY = "k".repeat(40);

test("blast-infra's origin is BLAST_INFRA_ORIGIN: required, bare, and https in production", () => {
  assert.equal(marketDataOrigin({ BLAST_INFRA_ORIGIN: "https://api.blast.fun/" }), "https://api.blast.fun");
  assert.equal(marketDataOrigin({ BLAST_INFRA_ORIGIN: "http://127.0.0.1:8080" }), "http://127.0.0.1:8080");
  for (const [value, environment, expected] of [
    [undefined, {}, /BLAST_INFRA_ORIGIN is required/],
    ["api.blast.fun", {}, /must be a bare HTTP\(S\) origin/],
    ["https://api.blast.fun/v1", {}, /must be a bare HTTP\(S\) origin/],
    ["https://user:pass@api.blast.fun", {}, /must be a bare HTTP\(S\) origin/],
    ["http://api.blast.fun", { BLAST_DEPLOYMENT_TARGET: "production" }, /must be a bare HTTPS origin/],
  ] as const) {
    assert.throws(() => marketDataOrigin({ ...environment, BLAST_INFRA_ORIGIN: value }), expected, String(value));
  }
});

test("review L8: the deprecated NEXT_PUBLIC_BLAST_INFRA_ORIGIN is never read; only BLAST_INFRA_ORIGIN configures the origin", () => {
  assert.throws(() => marketDataOrigin({ NEXT_PUBLIC_BLAST_INFRA_ORIGIN: "https://old.blast.test" }), /^Error: BLAST_INFRA_ORIGIN is required for market reads\.$/);
  assert.equal(
    marketDataOrigin({ BLAST_INFRA_ORIGIN: "https://new.blast.test", NEXT_PUBLIC_BLAST_INFRA_ORIGIN: "https://old.blast.test" }),
    "https://new.blast.test",
  );
  assert.equal(readFileSync(new URL("./blast-infra.ts", import.meta.url), "utf8").includes("environment.NEXT_PUBLIC_BLAST_INFRA_ORIGIN"), false);
});

test("blast-infra's origin names one DNS host or IP address, never a wildcard", () => {
  for (const value of ["https://infra.blast.test", "https://infra.blast.test:8443", "http://localhost:8080", "http://127.0.0.1:9000", "http://[::1]:9000"]) {
    assert.equal(marketDataOrigin({ BLAST_INFRA_ORIGIN: value }), value);
  }
  for (const [value, environment] of [
    ["https://*.blast.test", {}],
    ["https://*.blast.test", { BLAST_DEPLOYMENT_TARGET: "production" }],
    ["https://a.b*c.test", {}],
    ["https://*", {}],
    ["https://%2A.blast.test", {}],
    ["https://＊.blast.test", {}],
    ["https://a_b.blast.test", {}],
    ["https://a;b.test", {}],
    ["https://a,b.test", {}],
    ["https://a'b.test", {}],
    ["https://a..b.test", {}],
  ] as const) {
    assert.throws(
      () => marketDataOrigin({ ...environment, BLAST_INFRA_ORIGIN: value }),
      /^Error: BLAST_INFRA_ORIGIN must be a bare HTTP(?:\(S\)|S) origin\.$/,
      value,
    );
  }
});

test("BLAST_INFRA_API_KEY is optional, 32 to 512 printable characters, and its refusal never repeats it", () => {
  assert.equal(blastInfraApiKey({}), null);
  assert.equal(blastInfraApiKey({ BLAST_INFRA_API_KEY: "  " }), null);
  assert.equal(blastInfraApiKey({ BLAST_INFRA_API_KEY: ` ${KEY} ` }), KEY);
  for (const bad of ["short-key", `${"k".repeat(20)} ${"k".repeat(20)}`, `${"k".repeat(20)}\n${"k".repeat(20)}`, "k".repeat(513), `${"k".repeat(40)}é`]) {
    assert.throws(
      () => blastInfraApiKey({ BLAST_INFRA_API_KEY: bad }),
      (error: Error) => error.message === "BLAST_INFRA_API_KEY must be 32 to 512 printable characters without spaces." && !error.message.includes(bad.trim()),
      JSON.stringify(bad),
    );
  }
  assert.equal(BLAST_INFRA_KEY_HEADER, "x-blast-infra-key");
});

/** A fetch that records each request's URL and headers. */
function recording() {
  const seen: { url: string; headers: Headers; init?: RequestInit }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    seen.push({ url, headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)), init });
    return new Response("{}");
  }) as typeof fetch;
  return { seen, fetcher };
}

test("blastInfraFetch adds the key header to blast-infra's origin only, keeping the request's own headers", async () => {
  const { seen, fetcher } = recording();
  const keyed = blastInfraFetch({ origin: "https://infra.blast.test", fetch: fetcher, environment: { BLAST_INFRA_API_KEY: KEY } });
  await keyed(new URL("https://infra.blast.test/v1/status"), { headers: { accept: "application/json" } });
  await keyed("https://infra.blast.test/v1/presales?limit=1");
  await keyed(new Request("https://infra.blast.test/v1/status", { headers: { accept: "application/json" } }));
  await keyed("https://elsewhere.test/v1/status", { headers: { accept: "application/json" } });
  await keyed("http://infra.blast.test/v1/status");
  assert.deepEqual(
    seen.map(({ url, headers }) => [url, headers.get(BLAST_INFRA_KEY_HEADER), headers.get("accept")]),
    [
      ["https://infra.blast.test/v1/status", KEY, "application/json"],
      ["https://infra.blast.test/v1/presales?limit=1", KEY, null],
      ["https://infra.blast.test/v1/status", KEY, "application/json"],
      ["https://elsewhere.test/v1/status", null, "application/json"],
      ["http://infra.blast.test/v1/status", null, null],
    ],
    "another host, or another scheme, never sees the key",
  );
});

test("without a key blastInfraFetch sends the request as it is; the default origin is BLAST_INFRA_ORIGIN", async () => {
  const { seen, fetcher } = recording();
  await blastInfraFetch({ origin: "https://infra.blast.test", fetch: fetcher, environment: {} })("https://infra.blast.test/v1/status");
  assert.equal(seen[0].headers.get(BLAST_INFRA_KEY_HEADER), null);
  const environment = { BLAST_INFRA_ORIGIN: "https://infra.blast.test", BLAST_INFRA_API_KEY: KEY };
  await blastInfraFetch({ fetch: fetcher, environment })("https://infra.blast.test/v1/status");
  assert.equal(seen[1].headers.get(BLAST_INFRA_KEY_HEADER), KEY);
});

test("the server's /v1 dependencies use the origin, the keyed fetch and the expected deployment; unconfigured throws", async () => {
  assert.throws(() => defaultMarketDataDependencies({}), /BLAST_INFRA_ORIGIN is required/);
  assert.throws(() => defaultMarketDataDependencies({ BLAST_INFRA_ORIGIN: "https://infra.blast.test", BLAST_INFRA_API_KEY: "short" }), /BLAST_INFRA_API_KEY must be/);
  const dependencies = defaultMarketDataDependencies({ BLAST_INFRA_ORIGIN: "https://infra.blast.test/" });
  assert.equal(dependencies.origin, "https://infra.blast.test");
  assert.equal(dependencies.timeoutMs, 3_000);
  assert.equal(dependencies.expected, null);
});

test("review L7: a keyed request never follows a redirect, so the key cannot reach the host a 3xx names", async () => {
  const { createServer } = await import("node:http");
  const elsewhereHeaders: (string | undefined)[] = [];
  const elsewhere = createServer((request, response) => {
    elsewhereHeaders.push(request.headers[BLAST_INFRA_KEY_HEADER] as string | undefined);
    response.end("{}");
  });
  await new Promise<void>((resolve) => elsewhere.listen(0, "127.0.0.1", resolve));
  const elsewherePort = (elsewhere.address() as { port: number }).port;
  const infra = createServer((_request, response) => {
    response.writeHead(302, { location: `http://127.0.0.1:${elsewherePort}/v1/status` });
    response.end();
  });
  await new Promise<void>((resolve) => infra.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(infra.address() as { port: number }).port}`;
  try {
    const keyed = blastInfraFetch({ origin, environment: { BLAST_INFRA_API_KEY: KEY } });
    await assert.rejects(keyed(`${origin}/v1/status`), "a redirect is an upstream failure");
    assert.deepEqual(elsewhereHeaders, [], "the redirect target was never asked");
    const { seen, fetcher } = recording();
    await blastInfraFetch({ origin, fetch: fetcher, environment: { BLAST_INFRA_API_KEY: KEY } })(`${origin}/v1/status`, { redirect: "follow" });
    assert.equal(seen[0]?.init?.redirect, "error", "the caller cannot ask to follow one");
  } finally {
    await new Promise((resolve) => infra.close(resolve));
    await new Promise((resolve) => elsewhere.close(resolve));
  }
});
