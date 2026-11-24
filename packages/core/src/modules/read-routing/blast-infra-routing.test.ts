import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";

import { BLAST_INFRA_KEY_HEADER, blastInfraFetch } from "./blast-infra.ts";

const WRITER = "https://writer.blast.test";
const READER = "https://reader.blast.test";
const PATH = `/v1/launches/0x${"a".repeat(64)}/activity`;
const KEY = "k".repeat(40);
const enabled = {
  BLAST_INFRA_READ_MODE: "committed-markets",
  BLAST_INFRA_READ_ORIGIN: READER,
  BLAST_INFRA_API_KEY: KEY,
};

function recording(environment: Record<string, string | undefined> = enabled) {
  const seen: Request[] = [];
  const response = new Response("original body", { status: 206, headers: { "x-original": "yes" } });
  const fetcher = blastInfraFetch({ origin: WRITER, environment, fetch: (async (input, init) => {
    seen.push(new Request(input, init));
    return response;
  }) as typeof fetch });
  return { seen, response, fetcher };
}

test("independent committed activity preserves the request context and returns the original response after exactly one fetch", async () => {
  const { seen, response, fetcher } = recording();
  const controller = new AbortController();
  const query = "?limit=50&before=12%3A2%3A1%3A0";
  const request = new Request(`${WRITER}${PATH}${query}`, {
    headers: { accept: "application/json", "x-context": "admitted-once" },
    signal: controller.signal,
    cache: "no-store",
  });
  assert.equal(await fetcher(request, { headers: { "x-request-id": "trace-1" }, redirect: "follow" }), response);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, `${READER}${PATH}${query}`);
  assert.equal(seen[0].method, "GET");
  assert.equal(seen[0].headers.get("x-context"), "admitted-once");
  assert.equal(seen[0].headers.get("x-request-id"), "trace-1");
  assert.equal(seen[0].headers.get("accept"), "application/json");
  assert.equal(seen[0].headers.get(BLAST_INFRA_KEY_HEADER), KEY);
  assert.equal(seen[0].redirect, "error");
  assert.equal(seen[0].cache, "no-store");
  controller.abort();
  assert.equal(seen[0].signal.aborted, true);
  assert.equal(request.url, `${WRITER}${PATH}${query}`);
  await fetcher(new Request(`${WRITER}${PATH}`), { method: "HEAD" });
  assert.equal(seen[1].url, `${READER}${PATH}`);
  assert.equal(seen[1].method, "HEAD");
});

test("private, websocket, unrecognized routes and mutation methods never select the reader", async () => {
  const { seen, fetcher } = recording();
  const paths = [`${PATH}/`, "/v1/launches/0x1/activity", "/v1/ws", "/api/social/me", "/v1/admin"];
  for (const path of paths) await fetcher(`${WRITER}${path}`);
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) await fetcher(`${WRITER}${PATH}`, { method });
  assert.equal(seen.length, paths.length + 4);
  assert.ok(seen.every((request) => new URL(request.url).origin === WRITER));
  await fetcher(`https://other.blast.test${PATH}`);
  await fetcher(`${READER}${PATH}`);
  assert.equal(seen.at(-2)?.headers.get(BLAST_INFRA_KEY_HEADER), null);
  assert.equal(seen.at(-1)?.headers.get(BLAST_INFRA_KEY_HEADER), null, "direct reader input is not a credential-bearing writer request");
});

test("hot-memory routing is the default; an origin alone does not change unkeyed fetch arguments", async () => {
  const input = new Request(`${WRITER}${PATH}`);
  const init = { cache: "no-store" as const };
  let calls = 0;
  const fetcher = blastInfraFetch({ environment: { BLAST_INFRA_READ_ORIGIN: "invalid unused target" }, fetch: (async (actual, actualInit) => {
    calls += 1;
    assert.equal(actual, input);
    assert.equal(actualInit, init);
    return new Response();
  }) as typeof fetch });
  await fetcher(input, init);
  assert.equal(calls, 1);
  const disabled = recording({ ...enabled, BLAST_INFRA_READ_MODE: " " });
  await disabled.fetcher(input);
  assert.equal(disabled.seen[0].url, input.url);
  assert.equal(disabled.seen[0].headers.get(BLAST_INFRA_KEY_HEADER), KEY);
});

test("explicit invalid routing fails closed before any fetch; HTTP is limited to loopback", () => {
  const badOrigins = [undefined, "", "garbage", "http://reader.blast.test", "ftp://localhost", "https://reader.blast.test/path",
    "https://user:secret@reader.blast.test", "https://reader.blast.test?x=1", "https://reader.blast.test#fragment", "https://*.blast.test"];
  for (const origin of badOrigins) {
    assert.throws(() => recording({ ...enabled, BLAST_INFRA_READ_ORIGIN: origin }), /BLAST_INFRA_READ_ORIGIN/);
  }
  for (const mode of ["*", "raw-activity", "/v1/launches/{id}/activity"]) {
    assert.throws(() => recording({ ...enabled, BLAST_INFRA_READ_MODE: mode }), /BLAST_INFRA_READ_MODE/);
  }
  for (const origin of ["http://127.0.0.1:9000", "http://localhost:9000", "http://[::1]:9000", READER]) {
    assert.doesNotThrow(() => recording({ ...enabled, BLAST_INFRA_READ_ORIGIN: origin }));
  }
});

test("a reader refusal or transport failure makes one attempt with no writer fallback", async () => {
  for (const status of [401, 404, 503]) {
    let calls = 0;
    const response = new Response("refused", { status });
    const fetcher = blastInfraFetch({ origin: WRITER, environment: enabled, fetch: (async () => { calls += 1; return response; }) as typeof fetch });
    assert.equal(await fetcher(`${WRITER}${PATH}`), response);
    assert.equal(calls, 1);
  }
  let calls = 0;
  const fetcher = blastInfraFetch({ origin: WRITER, environment: enabled, fetch: (async () => { calls += 1; throw new Error("unreachable"); }) as typeof fetch });
  await assert.rejects(fetcher(`${WRITER}${PATH}`), /unreachable/);
  assert.equal(calls, 1);
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

test("loopback writer/reader return identical raw bytes and keyed redirects never escape", async () => {
  const seen: string[] = [];
  const body = '{"data":[{"amount":"9007199254740993"}],"next_cursor":"12:2:1:0"}';
  const writer = createServer((_request, response) => { seen.push("writer"); response.end(body); });
  const writerOrigin = await listen(writer);
  const reader = createServer((request, response) => {
    seen.push("reader");
    assert.equal(request.headers[BLAST_INFRA_KEY_HEADER], KEY);
    if (request.url?.includes("redirect")) response.writeHead(302, { location: `${writerOrigin}${PATH}` });
    response.end(body);
  });
  const readerOrigin = await listen(reader);
  try {
    const hotMemory = blastInfraFetch({ origin: writerOrigin, environment: { BLAST_INFRA_API_KEY: KEY } });
    const routed = blastInfraFetch({ origin: writerOrigin, environment: { ...enabled, BLAST_INFRA_READ_ORIGIN: readerOrigin } });
    const before = await hotMemory(`${writerOrigin}${PATH}?limit=50`);
    const after = await routed(`${writerOrigin}${PATH}?limit=50`);
    assert.equal(before.status, 200);
    assert.equal(after.status, 200);
    assert.equal(await before.text(), body);
    assert.equal(await after.text(), body);
    await assert.rejects(routed(`${writerOrigin}${PATH}?redirect=1`));
    assert.deepEqual(seen, ["writer", "reader", "reader"]);
  } finally {
    writer.closeAllConnections();
    reader.closeAllConnections();
    await Promise.all([new Promise((resolve) => writer.close(resolve)), new Promise((resolve) => reader.close(resolve))]);
  }
});
