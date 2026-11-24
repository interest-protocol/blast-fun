import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { Socket as TcpSocket } from "node:net";
import test, { type TestContext } from "node:test";

import { infraProvenanceFixture } from "../../../../test/fixtures/modules/launchpad-contract/fixtures.ts";
import {
  ActivityHintRelay,
  type RelaySocket,
} from "@blast/server/modules/social/activity/hint-relay.ts";
import {
  activityHintStream,
  openActivitySocket,
} from "@blast/server/modules/social/activity/hint-runtime.ts";
import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";

const HELLO = {
  type: "hello",
  protocol: 1,
  provenance: infraProvenanceFixture({ deployment_fingerprint: null }),
};
const TEST_INFRA_KEY = "a".repeat(32);

function configureInfra(origin: string): () => void {
  const previous = {
    BLAST_INFRA_ORIGIN: process.env.BLAST_INFRA_ORIGIN,
    BLAST_INFRA_READ_MODE: process.env.BLAST_INFRA_READ_MODE,
    BLAST_INFRA_READ_ORIGIN: process.env.BLAST_INFRA_READ_ORIGIN,
    BLAST_INFRA_API_KEY: process.env.BLAST_INFRA_API_KEY,
    BLAST_DEPLOYMENT_TARGET: process.env.BLAST_DEPLOYMENT_TARGET,
    BLAST_WORKER_ENVIRONMENT: process.env.BLAST_WORKER_ENVIRONMENT,
    VERCEL: process.env.VERCEL,
    VERCEL_ENV: process.env.VERCEL_ENV,
  };
  // A dead writer: the socket must reach the reader origin, never the writer.
  process.env.BLAST_INFRA_ORIGIN = "https://writer.invalid";
  process.env.BLAST_INFRA_READ_MODE = "committed-markets";
  process.env.BLAST_INFRA_READ_ORIGIN = origin;
  process.env.BLAST_INFRA_API_KEY = TEST_INFRA_KEY;
  delete process.env.BLAST_DEPLOYMENT_TARGET;
  delete process.env.BLAST_WORKER_ENVIRONMENT;
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

async function localOrigin(t: TestContext, server: Server): Promise<string> {
  const sockets = new Set<TcpSocket>();
  server.on("connection", (socket) => sockets.add(socket));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

class Socket implements RelaySocket {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: unknown[] = [];
  closed = false;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

function world() {
  const sockets: Socket[] = [];
  const relay = new ActivityHintRelay(() => {
    const socket = new Socket();
    sockets.push(socket);
    return socket;
  });
  const stream = () =>
    relay.stream(new Request("https://blast.test/api/social/activity/hints"));
  return { sockets, relay, stream };
}

async function frame(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const read = await reader.read();
  assert.equal(read.done, false);
  return JSON.parse(new TextDecoder().decode(read.value).slice(6).trim());
}

test("tabs share one private subscription, only public hint fields cross SSE, and the last disconnect releases it", async () => {
  const w = world();
  const first = w.stream();
  const second = w.stream();
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.equal(first.headers.get("content-type"), "text/event-stream");
  const a = first.body!.getReader();
  const b = second.body!.getReader();
  try {
    assert.equal(w.sockets.length, 1);
    const socket = w.sockets[0]!;
    socket.receive({ ...HELLO, engine_id: "private-diagnostics" });
    assert.deepEqual(socket.sent, [
      { op: "subscribe", topics: ["activity"] },
      { op: "ping" },
    ]);
    assert.deepEqual(await frame(a), {
      type: "hello",
      provenance: HELLO.provenance,
    });
    assert.deepEqual(await frame(b), {
      type: "hello",
      provenance: HELLO.provenance,
    });
    socket.receive({ type: "pong" });
    assert.deepEqual(await frame(a), { type: "pong" });
    assert.deepEqual(await frame(b), { type: "pong" });
    socket.receive({
      type: "activity",
      activity_id: "10:2:0:0",
      actor: "private",
      amount: "999",
    });
    assert.deepEqual(await frame(a), {
      type: "activity",
      activity_id: "10:2:0:0",
    });
    assert.deepEqual(await frame(b), {
      type: "activity",
      activity_id: "10:2:0:0",
    });
    for (const state of ["opened", "funded", "migrated", "cancelled"]) {
      const lifecycle = {
        type: "presale_lifecycle",
        presale_id: `0x${"a".repeat(64)}`,
        state,
      };
      socket.receive(lifecycle);
      assert.deepEqual(await frame(a), lifecycle);
      assert.deepEqual(await frame(b), lifecycle);
    }
    const late = w.stream().body!.getReader();
    assert.deepEqual(await frame(late), {
      type: "hello",
      provenance: HELLO.provenance,
    });
    assert.deepEqual(await frame(late), { type: "pong" });
    await late.cancel();
    await a.cancel();
    assert.equal(socket.closed, false);
    await b.cancel();
    assert.equal(socket.closed, true);
  } finally {
    await a.cancel();
    await b.cancel();
  }
});

test("coin identity changes come from feed, asked once activity is live, and cross SSE as the coin and cursor alone", async () => {
  const w = world();
  const reader = w.stream().body!.getReader();
  try {
    const socket = w.sockets[0]!;
    socket.receive(HELLO);
    assert.deepEqual(await frame(reader), { type: "hello", provenance: HELLO.provenance });
    socket.receive({ type: "pong" });
    assert.deepEqual(await frame(reader), { type: "pong" });
    assert.deepEqual(socket.sent, [
      { op: "subscribe", topics: ["activity"] },
      { op: "ping" },
      { op: "subscribe", topics: ["feed"] },
      { op: "ping" },
    ]);
    socket.receive({ type: "pong" });
    const coin = `0x${"3f".repeat(32)}::froggy::FROGGY`;
    const identity = { name: "Froggy", symbol: "FROGGY", description: "private", icon_url: "https://evil.test/x.png" };
    // Feed's other messages and a malformed identity change cross nothing.
    socket.receive({ type: "pool_created", pool: { pool_key: "blast_curve:0x1", metadata: identity } });
    socket.receive({ type: "lifecycle", pool_key: "blast_curve:0x1", lifecycle: "live" });
    socket.receive({ type: "metadata", coin: "0x2::sui::SUI", cursor: "10:2:4294967295:0", metadata: identity });
    socket.receive({ type: "metadata", coin, cursor: "10:2", metadata: identity });
    socket.receive({ type: "metadata", coin, cursor: "10:2:4294967295:0", checkpoint: 10, metadata: identity, decimals: "6" });
    assert.deepEqual(await frame(reader), { type: "metadata", coin, cursor: "10:2:4294967295:0" });
    socket.receive({ type: "activity", activity_id: "11:1:0:0" });
    assert.deepEqual(await frame(reader), { type: "activity", activity_id: "11:1:0:0" });
  } finally {
    await reader.cancel();
  }
});

test("an engine that refuses feed keeps the activity hints: only an error after it ends the stream", async () => {
  const w = world();
  const reader = w.stream().body!.getReader();
  try {
    const socket = w.sockets[0]!;
    socket.receive(HELLO);
    await frame(reader);
    socket.receive({ type: "pong" });
    await frame(reader);
    socket.receive({ type: "error", error: { code: "not_ready", message: "the launchpad is not configured" } });
    socket.receive({ type: "pong" });
    assert.equal(socket.closed, false);
    socket.receive({ type: "activity", activity_id: "12:1:0:0" });
    assert.deepEqual(await frame(reader), { type: "activity", activity_id: "12:1:0:0" });
    socket.receive({ type: "error", error: { code: "internal", message: "later" } });
    assert.equal(socket.closed, true);
    assert.equal((await reader.read()).done, true);
  } finally {
    await reader.cancel();
  }
});

test("wrong-network hellos and upstream failure close streams so browsers can reconnect and poll", async () => {
  const w = world();
  const a = w.stream().body!.getReader();
  w.sockets[0]!.receive({
    ...HELLO,
    provenance: infraProvenanceFixture({ network: "testnet" }),
  });
  assert.equal((await a.read()).done, true);
  assert.equal(w.sockets[0]!.closed, true);
  const b = w.stream().body!.getReader();
  assert.equal(w.sockets.length, 2);
  w.sockets[1]!.onerror?.();
  assert.equal((await b.read()).done, true);
  assert.equal(w.sockets[1]!.closed, true);
});

test("request aborts and slow readers close their bounded stream and release the upstream", async () => {
  const w = world();
  const abort = new AbortController();
  const reader = w.relay
    .stream(
      new Request("https://blast.test/api/social/activity/hints", {
        signal: abort.signal,
      }),
    )
    .body!.getReader();
  abort.abort();
  assert.equal((await reader.read()).done, true);
  assert.equal(w.sockets[0]!.closed, true);
  const slow = w.stream().body!.getReader();
  const socket = w.sockets[1]!;
  socket.receive(HELLO);
  socket.receive({ type: "pong" });
  for (let i = 0; i < 70; i += 1)
    socket.receive({ type: "activity", activity_id: String(i) });
  assert.equal(
    socket.closed,
    true,
    "unread hints cannot accumulate indefinitely",
  );
  await slow.cancel();
});

test("the public stream rejects cross-origin requests before opening infra", async () => {
  const response = await activityHintStream(
    new Request("https://blast.test/api/social/activity/hints", {
      headers: { origin: "https://evil.test", "sec-fetch-site": "cross-site" },
    }), testClient(),
  );
  assert.equal(response.status, 403);
  assert.ok(response.headers.get("x-request-id"));
  assert.deepEqual(await response.json(), {
    error: {
      code: "origin_invalid",
      message: "Use Blast on its own site to continue.",
    },
  });
});

test("the real upstream handshake authenticates only to the configured origin and streams committed hints", async () => {
  const { WebSocketServer } = createRequire(import.meta.url)("ws");
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const restoreInfra = configureInfra(
    `http://127.0.0.1:${server.address().port}`,
  );
  let receivedKey: string | undefined;
  let receivedPath: string | undefined;
  server.on(
    "connection",
    (
      socket: {
        send(data: string): void;
        on(name: string, run: (data: { toString(): string }) => void): void;
      },
      request: { headers: Record<string, string>; url: string },
    ) => {
      receivedKey = request.headers["x-blast-infra-key"];
      receivedPath = request.url;
      socket.send(JSON.stringify(HELLO));
      socket.on("message", (data) => {
        if (JSON.parse(data.toString()).op === "ping") {
          socket.send(JSON.stringify({ type: "pong" }));
          socket.send(
            JSON.stringify({ type: "activity", activity_id: "11:0:0:0" }),
          );
        }
      });
    },
  );
  const relay = new ActivityHintRelay(openActivitySocket);
  const reader = relay
    .stream(new Request("https://blast.test/api/social/activity/hints"))
    .body!.getReader();
  try {
    assert.equal((await frame(reader)).type, "hello");
    assert.deepEqual(await frame(reader), { type: "pong" });
    assert.deepEqual(await frame(reader), {
      type: "activity",
      activity_id: "11:0:0:0",
    });
    assert.equal(receivedKey, TEST_INFRA_KEY);
    assert.equal(receivedPath, "/v1/ws");
  } finally {
    await reader.cancel();
    await new Promise<void>((resolve) => server.close(resolve));
    restoreInfra();
  }
});

test(
  "upstream redirects are refused before the infra key can reach a second origin",
  { timeout: 3_000 },
  async (t) => {
    const redirectedKeys: (string | string[] | undefined)[] = [];
    const target = createServer((request, response) => {
      redirectedKeys.push(request.headers["x-blast-infra-key"]);
      response.writeHead(400).end();
    });
    target.on("upgrade", (request, socket) => {
      redirectedKeys.push(request.headers["x-blast-infra-key"]);
      socket.end(
        "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
    });
    const targetOrigin = await localOrigin(t, target);
    let receivedKey: string | string[] | undefined;
    const redirect = createServer();
    redirect.on("upgrade", (request, socket) => {
      receivedKey = request.headers["x-blast-infra-key"];
      socket.end(
        `HTTP/1.1 302 Found\r\nLocation: ${targetOrigin}/v1/ws\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
    });
    t.after(configureInfra(await localOrigin(t, redirect)));
    const relay = new ActivityHintRelay(openActivitySocket);
    const reader = relay
      .stream(new Request("https://blast.test/api/social/activity/hints"))
      .body!.getReader();
    t.after(() => reader.cancel());
    assert.equal(
      (await reader.read()).done,
      true,
      "a refused upgrade must close its SSE stream",
    );
    assert.equal(receivedKey, TEST_INFRA_KEY);
    assert.deepEqual(
      redirectedKeys,
      [],
      "the second origin must receive neither a request nor the key",
    );
  },
);

test("maximum valid hint fields remain within the explicit per-chunk byte budget", async () => {
  const { ACTIVITY_HINT_STREAM_BUDGET } = await import(
    "@blast/core/modules/backend-api/stream-budget.ts"
  );
  const w = world();
  const reader = w.stream().body!.getReader();
  const socket = w.sockets[0]!;
  async function boundedFrame() {
    const next = await reader.read();
    assert.equal(next.done, false);
    assert.ok(
      next.value!.byteLength <= ACTIVITY_HINT_STREAM_BUDGET.maxChunkBytes,
    );
    return JSON.parse(new TextDecoder().decode(next.value).slice(6).trim());
  }
  try {
    const provenance = infraProvenanceFixture({
      deployment_fingerprint: "f".repeat(64),
      checkpoint: Number.MAX_SAFE_INTEGER,
      timestamp_ms: Number.MAX_SAFE_INTEGER,
      observed_ms: Number.MAX_SAFE_INTEGER,
      lag_ms: Number.MAX_SAFE_INTEGER,
    });
    socket.receive({ ...HELLO, provenance });
    assert.deepEqual(await boundedFrame(), { type: "hello", provenance });
    socket.receive({ type: "pong" });
    assert.deepEqual(await boundedFrame(), { type: "pong" });
    const activity = { type: "activity", activity_id: "\u0000".repeat(128) };
    socket.receive(activity);
    assert.deepEqual(
      await boundedFrame(),
      activity,
      "JSON escaping is included in the byte bound",
    );
    const lifecycle = {
      type: "presale_lifecycle",
      presale_id: "0x" + "f".repeat(64),
      state: "cancelled",
    };
    socket.receive(lifecycle);
    assert.deepEqual(await boundedFrame(), lifecycle);
  } finally {
    await reader.cancel();
  }
});

test("worst escaped hints close a slow consumer at the explicit queue bound", async () => {
  const { ACTIVITY_HINT_STREAM_BUDGET: budget } = await import(
    "@blast/core/modules/backend-api/stream-budget.ts"
  );
  const w = world();
  const reader = w.stream().body!.getReader();
  const socket = w.sockets[0]!;
  socket.receive(HELLO);
  socket.receive({ type: "pong" });
  // Leave hello, pong and subsequent maximum-length hints unread.
  const activity = { type: "activity", activity_id: "\u0000".repeat(128) };
  for (let i = 2; i < budget.queuedChunks; i++) socket.receive(activity);
  assert.equal(
    socket.closed,
    false,
    "exactly the bounded queue remains connected",
  );
  socket.receive(activity);
  assert.equal(
    socket.closed,
    true,
    "the next frame releases the slow consumer",
  );
  let chunks = 0;
  let bytes = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    chunks++;
    bytes += next.value.byteLength;
    assert.ok(next.value.byteLength <= budget.maxChunkBytes);
  }
  assert.equal(chunks, budget.queuedChunks);
  assert.ok(bytes <= budget.queuedChunks * budget.maxChunkBytes);
  assert.equal(
    budget.maxClients * budget.queuedChunks * budget.maxChunkBytes,
    budget.queuePayloadBudgetBytes,
  );
});

function relayObservations(t: TestContext) {
  const previous = process.env.MISSION_CONTROL_METRICS;
  process.env.MISSION_CONTROL_METRICS = "on";
  t.after(() => { if (previous === undefined) delete process.env.MISSION_CONTROL_METRICS; else process.env.MISSION_CONTROL_METRICS = previous; });
  const records: Record<string, unknown>[] = [];
  t.mock.method(console, "info", (line: string) => { records.push(JSON.parse(line)); });
  return records;
}

test("malformed upstream data closes all relay clients and records one safe failure", async (t) => {
  const records = relayObservations(t);
  const socket = new Socket();
  const relay = new ActivityHintRelay(() => socket);
  const first = relay.stream(new Request("https://blast.test/hints")).body!.getReader();
  const second = relay.stream(new Request("https://blast.test/hints")).body!.getReader();
  socket.onmessage?.({ data: "private-provider-payload" });
  assert.deepEqual(await first.read(), { done: true, value: undefined });
  assert.deepEqual(await second.read(), { done: true, value: undefined });
  assert.equal(socket.closed, true);
  assert.deepEqual(records.filter((record) => record.metric === "social.hint_relay").map(({ reason, outcome, clients }) => ({ reason, outcome, clients })), [{ reason: "invalid_frame", outcome: "unavailable", clients: 2 }]);
  assert.equal(JSON.stringify(records).includes("private-provider-payload"), false);
});

test("an upstream handshake timeout is observable and closes the waiting stream", async (t) => {
  const records = relayObservations(t);
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const socket = new Socket();
  const relay = new ActivityHintRelay(() => socket);
  const reader = relay.stream(new Request("https://blast.test/hints")).body!.getReader();
  t.mock.timers.tick(10_000);
  assert.deepEqual(await reader.read(), { done: true, value: undefined });
  assert.deepEqual(records.filter((record) => record.metric === "social.hint_relay").map(({ reason, clients }) => ({ reason, clients })), [{ reason: "handshake_timeout", clients: 1 }]);
  assert.equal(socket.closed, true);
});
