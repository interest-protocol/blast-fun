import { deploymentIdentity } from "@blast/core/lib/config/deployment-identity.ts";
import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import test from "node:test";
import { Agent, fetch as undiciFetch } from "undici/index.js";
import { quotaNamespace } from "@blast/core/lib/web-security/redis-rate-limits.ts";
import {
  ActivityHintRelay,
  type RelaySocket,
} from "@blast/server/modules/social/activity/hint-relay.ts";
import { infraProvenanceFixture } from "../../../packages/server/test/fixtures/modules/launchpad-contract/fixtures.ts";
import { privateRoute } from "@blast/core/modules/backend-api/private-routes.ts";
import { createBackendServer } from "../src/app/server.ts";
import { relayToOneBackend } from "./relay-fixture.ts";

const siteOrigin = "https://frontend.test";
const environment = {
  NEXT_PUBLIC_SITE_URL: siteOrigin,
  BLAST_REDIS_NAMESPACE: "local-native-stream",
  BLAST_BACKEND_GATEWAY_SECRET: "synthetic-private-stream-secret-0123456789",
};

test("activity stream capability is exact and browser only", () => {
  const path = "/api/social/activity/hints";
  for (const method of ["GET", "HEAD"]) {
    const route = privateRoute(method, path, "browser");
    assert.equal(route?.maxBodyBytes, 0);
    assert.equal(route?.workBudgetMs, 300_000);
    assert.equal(privateRoute(method, path, "ssr-read"), null);
  }
  assert.equal(privateRoute("POST", path, "browser"), null);
});

test(
  "native SSE holds four configured connected permits and releases them on cancellation and HEAD",
  { timeout: 15_000 },
  async () => {
    let opened = 0;
    let closed = 0;
    const relayOwner = new ActivityHintRelay(() => {
      opened++;
      const socket: RelaySocket = {
        onmessage: null,
        onclose: null,
        onerror: null,
        send(text) {
          if (JSON.parse(text).op === "ping") {
            setTimeout(
              () =>
                socket.onmessage?.({
                  data: JSON.stringify({ type: "pong" }),
                } as Parameters<NonNullable<RelaySocket["onmessage"]>>[0]),
              0,
            );
          }
        },
        close() {
          closed++;
        },
      };
      setTimeout(
        () =>
          socket.onmessage?.({
            data: JSON.stringify({
              type: "hello",
              protocol: 1,
              provenance: infraProvenanceFixture({
                deployment_fingerprint: null,
              }),
            }),
          } as Parameters<NonNullable<RelaySocket["onmessage"]>>[0]),
        0,
      );
      return socket;
    });
    const runtime = createBackendServer({
      namespace: quotaNamespace(environment.BLAST_REDIS_NAMESPACE, deploymentIdentity(environment)),
      gatewaySecret: environment.BLAST_BACKEND_GATEWAY_SECRET,
      maxHintStreams: 4,
      maxInflight: 1,
      redis: {
        async execute() {
          return "OK";
        },
      },
      ready: async () => true,
      handle: async () => {
        assert.fail("Private requests cannot enter public admission");
      },
      privateApi: {
        siteOrigin,
        async handle(request, { proof }) {
          return proof.route.id === "social.activity.hints"
            ? relayOwner.stream(request)
            : Response.json({ ready: true });
        },
      },
    });
    const relay = relayToOneBackend(
      { ...environment, BLAST_BACKEND_API_ORIGIN: `http://127.0.0.1:${runtime.server.port}` },
      { clientAddress: () => "192.0.2.7" },
    );
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    const get = (method = "GET", path = "/api/social/activity/hints") =>
      relay(new Request(siteOrigin + path, { method }));
    try {
      for (let index = 0; index < 4; index++) {
        const response = await get();
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), "text/event-stream");
        const reader = response.body!.getReader();
        readers.push(reader);
        assert.equal((await reader.read()).done, false);
      }
      assert.equal(opened, 1);
      const full = await get();
      assert.equal(full.status, 503);
      await full.text();
      const ordinary = await get("GET", "/api/social/me");
      assert.equal(ordinary.status, 200);
      await ordinary.text();
      await readers.shift()!.cancel();
      await pause(50);
      const head = await get("HEAD");
      assert.equal(head.status, 200);
      assert.equal(await head.text(), "");
      await pause(50);
      const replacement = await get();
      assert.equal(replacement.status, 200);
      readers.push(replacement.body!.getReader());
      for (const reader of readers.splice(0)) {
        await reader.cancel();
      }
      for (let attempt = 0; attempt < 50 && closed === 0; attempt++) {
        await pause(10);
      }
      assert.equal(closed, 1, "last cancellation disconnects shared upstream");
      const finalHead = await get("HEAD");
      assert.equal(finalHead.status, 200);
      await finalHead.text();
      await pause(50);
      assert.equal(opened, closed, "HEAD leaves no upstream client");
    } finally {
      for (const reader of readers) {
        await reader.cancel();
      }
      await runtime.drain();
    }
  },
);

test(
  "configured stream capacity preserves ordinary admission with one multiplexed upstream",
  { timeout: 30_000 },
  async (t) => {
    const { ACTIVITY_HINT_STREAM_BUDGET } = await import(
      "@blast/core/modules/backend-api/stream-budget.ts"
    );
    const connectionStarted = performance.now();
    let opened = 0;
    let closed = 0;
    const owner = new ActivityHintRelay(() => {
      opened++;
      const socket: RelaySocket = {
        onmessage: null,
        onclose: null,
        onerror: null,
        send(text) {
          if (JSON.parse(text).op === "ping") {
            queueMicrotask(() =>
              socket.onmessage?.({
                data: JSON.stringify({ type: "pong" }),
              } as Parameters<NonNullable<RelaySocket["onmessage"]>>[0]),
            );
          }
        },
        close() {
          closed++;
        },
      };
      queueMicrotask(() =>
        socket.onmessage?.({
          data: JSON.stringify({
            type: "hello",
            protocol: 1,
            provenance: infraProvenanceFixture({
              deployment_fingerprint: null,
            }),
          }),
        } as Parameters<NonNullable<RelaySocket["onmessage"]>>[0]),
      );
      return socket;
    });
    const runtime = createBackendServer({
      namespace: quotaNamespace(environment.BLAST_REDIS_NAMESPACE, deploymentIdentity(environment)),
      gatewaySecret: environment.BLAST_BACKEND_GATEWAY_SECRET,
      maxHintStreams: ACTIVITY_HINT_STREAM_BUDGET.maxClients,
      maxInflight: 1,
      redis: {
        async execute() {
          return "OK";
        },
      },
      ready: async () => true,
      handle: async () => Response.json({ ordinary: true }),
      privateApi: {
        siteOrigin,
        async handle(request, { proof }) {
          return proof.route.id === "social.activity.hints"
            ? owner.stream(request)
            : Response.json({ ordinary: true });
        },
      },
    });
    // Bun's built-in fetch/undici alias stops at 256 open responses. The
    // package import above selects the real, explicitly bounded test client.
    const client = new Agent({
      connections: ACTIVITY_HINT_STREAM_BUDGET.maxClients + 2,
    });
    const relay = relayToOneBackend(
      { ...environment, BLAST_BACKEND_API_ORIGIN: `http://127.0.0.1:${runtime.server.port}` },
      {
        clientAddress: () => "192.0.2.7",
        fetch: (input, init) => {
          assert.equal(init?.method, "GET");
          return undiciFetch(input as URL, {
            method: init?.method,
            headers: Object.fromEntries(new Headers(init?.headers)),
            signal: init?.signal,
            redirect: init?.redirect,
            dispatcher: client,
          }) as unknown as Promise<Response>;
        },
      },
    );
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    try {
      for (let i = 0; i < ACTIVITY_HINT_STREAM_BUDGET.maxClients; i++) {
        if (i % 64 === 0) {
          t.diagnostic(`opening_stream=${i}`);
        }
        const response = await relay(new Request(siteOrigin + "/api/social/activity/hints"));
        assert.equal(response.status, 200);
        const reader = response.body!.getReader();
        readers.push(reader);
        const first = await reader.read();
        assert.equal(first.done, false);
        assert.ok(first.value!.byteLength <= ACTIVITY_HINT_STREAM_BUDGET.maxChunkBytes);
      }
      t.diagnostic(
        `connected=${readers.length} connection_ms=${(performance.now() - connectionStarted).toFixed(2)}`,
      );
      assert.equal(opened, 1);
      const full = await relay(new Request(siteOrigin + "/api/social/activity/hints"));
      assert.equal(full.status, 503);
      await full.text();
      const ordinaryStarted = performance.now();
      const ordinary = await relay(new Request(siteOrigin + "/api/social/me"));
      assert.equal(ordinary.status, 200);
      await ordinary.text();
      t.diagnostic(`ordinary_ms=${(performance.now() - ordinaryStarted).toFixed(2)}`);
      const ready = await fetch(`http://127.0.0.1:${runtime.server.port}/v1/health`);
      assert.equal(ready.status, 200);
      await ready.text();
    } finally {
      for (const reader of readers) {
        await reader.cancel();
      }
      await runtime.drain();
      await client.close();
    }
    assert.equal(closed, 1);
  },
);

test(
  "native drain closes an established hint stream and its upstream without client cancellation",
  { timeout: 3_000 },
  async () => {
    let closed = 0;
    const owner = new ActivityHintRelay(() => {
      const socket: RelaySocket = {
        onmessage: null,
        onclose: null,
        onerror: null,
        send(text) {
          if (JSON.parse(text).op === "ping") {
            queueMicrotask(() =>
              socket.onmessage?.({
                data: JSON.stringify({ type: "pong" }),
              } as Parameters<NonNullable<RelaySocket["onmessage"]>>[0]),
            );
          }
        },
        close() {
          closed++;
        },
      };
      queueMicrotask(() =>
        socket.onmessage?.({
          data: JSON.stringify({
            type: "hello",
            protocol: 1,
            provenance: infraProvenanceFixture({
              deployment_fingerprint: null,
            }),
          }),
        } as Parameters<NonNullable<RelaySocket["onmessage"]>>[0]),
      );
      return socket;
    });
    const runtime = createBackendServer({
      namespace: quotaNamespace(environment.BLAST_REDIS_NAMESPACE, deploymentIdentity(environment)),
      gatewaySecret: environment.BLAST_BACKEND_GATEWAY_SECRET,
      redis: {
        async execute() {
          return "OK";
        },
      },
      ready: async () => true,
      handle: async () => new Response("ordinary"),
      privateApi: {
        siteOrigin,
        handle: async (request) => owner.stream(request),
      },
    });
    const relay = relayToOneBackend(
      { ...environment, BLAST_BACKEND_API_ORIGIN: `http://127.0.0.1:${runtime.server.port}` },
      { clientAddress: () => "192.0.2.7" },
    );
    const response = await relay(new Request(siteOrigin + "/api/social/activity/hints"));
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    assert.equal((await reader.read()).done, false);
    try {
      await runtime.drain();
      assert.equal(closed, 1, "transport drain cancels owner body and releases shared upstream");
    } finally {
      await reader.cancel().catch(() => {});
      await runtime.drain();
    }
  },
);

test(
  "a drain window closes connected streams at spread moments, refuses new ones meanwhile, and resolves after the last",
  { timeout: 5_000 },
  async () => {
    const owner = new ActivityHintRelay(() => {
      const socket: RelaySocket = {
        onmessage: null,
        onclose: null,
        onerror: null,
        send(text) {
          if (JSON.parse(text).op === "ping") {
            queueMicrotask(() =>
              socket.onmessage?.({
                data: JSON.stringify({ type: "pong" }),
              } as Parameters<NonNullable<RelaySocket["onmessage"]>>[0]),
            );
          }
        },
        close() {},
      };
      queueMicrotask(() =>
        socket.onmessage?.({
          data: JSON.stringify({
            type: "hello",
            protocol: 1,
            provenance: infraProvenanceFixture({
              deployment_fingerprint: null,
            }),
          }),
        } as Parameters<NonNullable<RelaySocket["onmessage"]>>[0]),
      );
      return socket;
    });
    const windowMs = 600;
    const runtime = createBackendServer({
      namespace: quotaNamespace(environment.BLAST_REDIS_NAMESPACE, deploymentIdentity(environment)),
      gatewaySecret: environment.BLAST_BACKEND_GATEWAY_SECRET,
      redis: {
        async execute() {
          return "OK";
        },
      },
      ready: async () => true,
      handle: async () => new Response("ordinary"),
      privateApi: {
        siteOrigin,
        handle: async (request) => owner.stream(request),
      },
      streamDrainMs: windowMs,
    });
    const relay = relayToOneBackend(
      { ...environment, BLAST_BACKEND_API_ORIGIN: `http://127.0.0.1:${runtime.server.port}` },
      { clientAddress: () => "192.0.2.8" },
    );
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    const random = Math.random;
    try {
      for (let i = 0; i < 3; i++) {
        const response = await relay(new Request(siteOrigin + "/api/social/activity/hints"));
        assert.equal(response.status, 200);
        const reader = response.body!.getReader();
        assert.equal((await reader.read()).done, false);
        readers.push(reader);
      }
      const ended = readers.map(async (reader) => {
        for (;;) {
          const next = await reader.read().catch(() => ({ done: true }));
          if (next.done) {
            return performance.now();
          }
        }
      });
      const moments = [0, 0.5, 0.99];
      Math.random = () => moments.shift() ?? 0;
      const start = performance.now();
      const drained = runtime.drain().then(() => performance.now());
      Math.random = random;
      const late = await relay(new Request(siteOrigin + "/api/social/activity/hints"));
      assert.notEqual(late.status, 200, "a draining backend admits no new stream");
      await late.body?.cancel();
      const closedAt = (await Promise.all(ended)).map((at) => at - start);
      assert.ok(closedAt[0]! < 150, "the first closes at once");
      assert.ok(
        closedAt[1]! >= 250 && closedAt[1]! < 450,
        "the second near the middle of the window",
      );
      assert.ok(
        closedAt[2]! >= 500 && closedAt[2]! < windowMs + 300,
        "the last near the end of the window",
      );
      assert.ok(
        (await drained) - start >= 0.99 * windowMs - 50,
        "drain resolves only once the last stream's moment passed",
      );
    } finally {
      Math.random = random;
      for (const reader of readers) {
        await reader.cancel().catch(() => {});
      }
      await runtime.drain();
    }
  },
);
