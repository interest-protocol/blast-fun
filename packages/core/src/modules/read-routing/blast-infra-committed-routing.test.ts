import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import {
  BLAST_INFRA_KEY_HEADER,
  blastInfraFetch,
  blastInfraSocketUrl,
} from "./blast-infra.ts";
const id = "0x" + "a".repeat(64);
const writer = "https://writer.test";
const reader = "https://reader.test";
const key = "synthetic-infra-key-012345678901234567890123";
const environment = {
  BLAST_INFRA_ORIGIN: writer,
  BLAST_INFRA_READ_ORIGIN: reader,
  BLAST_INFRA_READ_MODE: "committed-markets",
  BLAST_INFRA_API_KEY: key,
};
const paths = [
  "/v1/status",
  "/v1/quotes",
  "/v1/pools?view=new",
  "/v1/bonding?stage=bonding&sort=progress&q=frog",
  `/v1/pools/blast_curve/${id}`,
  `/v1/pools/cetus/${id}/trades`,
  `/v1/pools/bluefin/${id}/candles`,
  "/v1/coins/0x2%3A%3Asui%3A%3ASUI",
  "/v1/coins/0x2::sui::SUI/holders",
  "/v1/coins/0x2::sui::SUI/trades",
  "/v1/coins/0x2::sui::SUI/candles",
  `/v1/launches/${id}/activity?view=classified&limit=5&cursor=opaque`,
  `/v1/launches/${id}/opening-round/bidders`,
  `/v1/wallets/${id}`,
  `/v1/wallets/${id}/positions`,
  `/v1/wallets/${id}/trades`,
  "/v1/traders/top",
  "/v1/presales",
  "/v1/presales/policy",
  `/v1/presales/${id}`,
  `/v1/presales/${id}/commitments`,
  `/v1/presales/${id}/wallets/${id}`,
  `/v1/wallets/${id}/presales`,
  `/v1/wallets/${id}/presale-vesting`,
  "/v1/stack",
  "/v1/vaults",
  `/v1/wallets/${id}/vault-rewards`,
  `/v1/vaults/${id}`,
  `/v1/vaults/${id}/rewards`,
  `/v1/launches/${id}/rewards?limit=5&cursor=opaque`,
  `/v1/wallets/${id}/launches`,
  `/v1/wallets/${id}/launch-rewards`,
  "/v1/partners",
  `/v1/partners/${id}`,
  "/v1/launchpad/policy",
  `/v1/creator-claims?recipient=${id}`,
  `/v1/creator-claims?account=${"a".repeat(64)}`,
];

test("full committed mode selects every canonical market/presale read while preserving request/response contracts", async () => {
  const seen: Request[] = [];
  const answer = new Response(
    '{"fixture":"unchanged","provenance":{"unchanged":true}}',
    { status: 206, headers: { "x-snapshot": "unchanged" } },
  );
  const transport = blastInfraFetch({
    environment,
    fetch: (async (input, init) => {
      seen.push(new Request(input, init));
      return answer;
    }) as typeof fetch,
  });
  const controller = new AbortController();
  for (const path of paths) {
    assert.equal(
      await transport(
        new Request(writer + path, {
          headers: { "x-request-id": "trace" },
          signal: controller.signal,
        }),
      ),
      answer,
    );
    const actual = seen.at(-1)!;
    assert.equal(actual.url, reader + path);
    assert.equal(actual.headers.get(BLAST_INFRA_KEY_HEADER), key);
    assert.equal(actual.headers.get("x-request-id"), "trace");
    assert.equal(actual.redirect, "error");
  }
  await transport(new Request(writer + paths[10]), { method: "HEAD" });
  assert.equal(seen.at(-1)!.method, "HEAD");
  controller.abort();
  assert.ok(seen[0].signal.aborted);
  for (const path of paths) {
    await transport(writer + path, { method: "HEAD" });
    assert.equal(seen.at(-1)!.url, reader + path);
    assert.equal(seen.at(-1)!.method, "HEAD");
    const hot = blastInfraFetch({
      environment: { ...environment, BLAST_INFRA_READ_MODE: "" },
      fetch: (async (input, init) => {
        seen.push(new Request(input, init));
        return new Response();
      }) as typeof fetch,
    });
    await hot(writer + path);
    assert.equal(new URL(seen.at(-1)!.url).origin, writer);
  }
  for (const path of [
    "/v1/health",
    "/v1/live",
    "/v1/ws",
    `/v1/presales/${id}/rewards`,
    `/v1/wallets/${id}/presale-rewards`,
    `/v1/launches/${id}/reward-rounds`,
    `/v1/wallets/${id}/launch-holder-rewards`,
    `/v1/partners/${id}/launches`,
    "/api/social/me",
    "/api/social/accounts",
    "/v1/admin",
    "/v1/pools/unknown/" + id,
  ]) {
    await transport(writer + path);
    assert.equal(new URL(seen.at(-1)!.url).origin, writer);
  }
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
    await transport(writer + "/v1/presales", { method });
    assert.equal(new URL(seen.at(-1)!.url).origin, writer);
  }
  await transport("https://unrelated.test/v1/presales");
  assert.equal(seen.at(-1)!.headers.get(BLAST_INFRA_KEY_HEADER), null);
});

test("complete committed reader and WebSocket selection require the same explicit mode", () => {
  assert.equal(
    blastInfraSocketUrl(environment).href,
    "wss://reader.test/v1/ws",
  );
  assert.throws(
    () => blastInfraSocketUrl({ ...environment, BLAST_INFRA_READ_MODE: "" }),
    /BLAST_INFRA_READ_MODE=committed-markets/,
  );
  for (const mode of ["*", "raw-activity"]) {
    assert.throws(
      () =>
        blastInfraFetch({
          environment: { ...environment, BLAST_INFRA_READ_MODE: mode },
        }),
      /BLAST_INFRA_READ_MODE/,
    );
  }
  assert.throws(
    () =>
      blastInfraFetch({
        environment: {
          ...environment,
          BLAST_INFRA_READ_ORIGIN: "https://user:secret@reader.test",
        },
      }),
    /BLAST_INFRA_READ_ORIGIN/,
  );
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
test("full reader refusal, disconnect and redirect cause no physical writer retry", async () => {
  let writerRequests = 0;
  const writerServer = createServer((_request, response) => {
    writerRequests++;
    response.end("writer");
  });
  const writerOrigin = await listen(writerServer);
  const readerServer = createServer((request, response) => {
    assert.equal(request.headers[BLAST_INFRA_KEY_HEADER], key);
    if (request.url?.includes("redirect")) {
      response.writeHead(302, { location: writerOrigin + "/v1/status" });
      response.end();
    } else if (request.url?.includes("disconnect")) request.socket.destroy();
    else {
      response.writeHead(503);
      response.end('{"error":{"code":"stale"}}');
    }
  });
  const readerOrigin = await listen(readerServer);
  try {
    const fetcher = blastInfraFetch({
      environment: {
        ...environment,
        BLAST_INFRA_ORIGIN: writerOrigin,
        BLAST_INFRA_READ_ORIGIN: readerOrigin,
      },
    });
    for (const path of paths) {
      for (const method of ["GET", "HEAD"]) {
        const refusal = await fetcher(writerOrigin + path, { method });
        assert.equal(refusal.status, 503, `${method} ${path}`);
        if (method === "GET")
          assert.deepEqual(await refusal.json(), { error: { code: "stale" } });
        else assert.equal(await refusal.text(), "");
        const separator = path.includes("?") ? "&" : "?";
        await assert.rejects(
          fetcher(writerOrigin + path + separator + "redirect=1", { method }),
        );
        await assert.rejects(
          fetcher(writerOrigin + path + separator + "disconnect=1", { method }),
        );
      }
    }
    assert.equal(writerRequests, 0);
  } finally {
    writerServer.closeAllConnections();
    readerServer.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => writerServer.close(resolve)),
      new Promise((resolve) => readerServer.close(resolve)),
    ]);
  }
});
