import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { boundedFetch } from "./bounded-fetch.ts";
import {
  createAfterResponseScheduler,
  createRequestWork,
  reserveAfterResponse,
  runWithRequestWork,
} from "./request-work.ts";

test(
  "a stalled loopback RPC is physically aborted and its work settles",
  { timeout: 5_000 },
  async (t) => {
    const deadline = new AbortController();
    t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
      assert.equal(milliseconds, 100);
      return deadline.signal;
    });
    let closed = false;
    const server = createServer((request, response) => {
      response.writeHead(200, { "Content-Type": "application/grpc-web+proto" });
      response.write("partial");
      request.once("close", () => {
        closed = true;
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    try {
      const response = await boundedFetch(100)(`http://127.0.0.1:${port}`);
      const body = response.arrayBuffer();
      deadline.abort(new DOMException("Deadline elapsed", "TimeoutError"));
      await assert.rejects(body);
      for (let attempt = 0; !closed && attempt < 100; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(closed, true, "Timeout must close the real response socket");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test("an earlier caller cancellation is preserved", async () => {
  const controller = new AbortController();
  controller.abort(new Error("synthetic cancellation"));
  await assert.rejects(
    boundedFetch(1_000)("http://127.0.0.1:1", { signal: controller.signal }),
  );
});

test(
  "delayed response headers are aborted too",
  { timeout: 5_000 },
  async () => {
    let closed = false;
    const server = createServer((request) => {
      request.once("close", () => {
        closed = true;
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const port = (server.address() as { port: number }).port;
      await assert.rejects(boundedFetch(100)(`http://127.0.0.1:${port}`));
      for (let attempt = 0; !closed && attempt < 100; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(closed, true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test("absolute request deadlines isolate concurrent scopes and stop later SDK pages before transport", async () => {
  const scheduler = createAfterResponseScheduler();
  const scope = createRequestWork(scheduler);
  const first = new AbortController(),
    second = new AbortController();
  const signals: AbortSignal[] = [];
  const rpc = boundedFetch(
    8_000,
    Object.assign(async (_input: unknown, init?: RequestInit) => {
      signals.push(init!.signal!);
      return new Response("page");
    }, fetch) as typeof fetch,
  );
  await Promise.all([
    runWithRequestWork(
      scope,
      async () => {
        await (await rpc("http://127.0.0.1/page-one")).text();
        first.abort(new Error("absolute request deadline"));
        await assert.rejects(
          rpc("http://127.0.0.1/page-two"),
          /absolute request deadline/,
        );
      },
      first.signal,
    ),
    runWithRequestWork(
      scope,
      async () => {
        await Promise.resolve();
        await (await rpc("http://127.0.0.1/other-request")).text();
        assert.equal(second.signal.aborted, false);
      },
      second.signal,
    ),
  ]);
  assert.equal(
    signals.length,
    2,
    "No transport may start for an aborted later coin page",
  );
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
  assert.equal(
    Object.hasOwn(scope, "signal"),
    false,
    "Never mutate a reusable work owner",
  );
  await scope.complete();
  await scheduler.drain();
});

test(
  "an absolute request abort physically settles an SDK body read which omitted signal",
  { timeout: 5_000 },
  async () => {
    let closed = false;
    const server = createServer((request, response) => {
      response.writeHead(200);
      response.write("partial");
      request.once("close", () => {
        closed = true;
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const controller = new AbortController();
    const scheduler = createAfterResponseScheduler(),
      scope = createRequestWork(scheduler);
    try {
      await runWithRequestWork(
        scope,
        async () => {
          const response = await boundedFetch(8_000)(
            `http://127.0.0.1:${(server.address() as { port: number }).port}`,
          );
          const body = response.arrayBuffer();
          controller.abort(new Error("absolute request deadline"));
          await assert.rejects(body);
        },
        controller.signal,
      );
      for (let attempt = 0; !closed && attempt < 100; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(closed, true);
    } finally {
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await scope.complete();
      await scheduler.drain();
    }
  },
);

test("accepted background work gets a fresh signal context after its trigger aborts", async () => {
  const scheduler = createAfterResponseScheduler(),
    scope = createRequestWork(scheduler);
  const controller = new AbortController();
  let calls = 0;
  const rpc = boundedFetch(
    8_000,
    Object.assign(async (_input: unknown, init?: RequestInit) => {
      assert.equal(init!.signal!.aborted, false);
      calls++;
      return new Response("job");
    }, fetch) as typeof fetch,
  );
  runWithRequestWork(
    scope,
    () =>
      reserveAfterResponse()!.attach(async () => {
        assert.equal(await (await rpc("http://127.0.0.1/job")).text(), "job");
      }),
    controller.signal,
  );
  controller.abort(new Error("trigger completed"));
  await scope.complete();
  await scheduler.drain();
  assert.equal(calls, 1);
});

test("absent context retains explicit caller semantics and refuses before transport", async () => {
  const requestController = new AbortController(),
    initController = new AbortController();
  let calls = 0;
  const rpc = boundedFetch(
    8_000,
    Object.assign(async (_input: unknown, init?: RequestInit) => {
      assert.equal(init!.signal!.aborted, false);
      calls++;
      return new Response("caller");
    }, fetch) as typeof fetch,
  );
  requestController.abort(new Error("request caller abort"));
  const request = new Request("http://127.0.0.1/caller", {
    signal: requestController.signal,
  });
  await assert.rejects(rpc(request), /request caller abort/);
  await (await rpc(request, { signal: initController.signal })).text();
  initController.abort(new Error("explicit init abort"));
  await assert.rejects(
    rpc(request, { signal: initController.signal }),
    /explicit init abort/,
  );
  assert.equal(calls, 1);
});
