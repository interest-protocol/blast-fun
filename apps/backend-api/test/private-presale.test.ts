import assert from "node:assert/strict";
import test from "node:test";
import { signPrivateRequest } from "@blast/core/modules/backend-api/private-gateway.ts";
import { privateRoute } from "@blast/core/modules/backend-api/private-routes.ts";
import { createBackendHttp, createBackendServer } from "../src/app/server.ts";

const origin = "https://frontend.test";
const secret = "synthetic-presale-transport-secret-0123456789";
const namespace = "b".repeat(64);

function signed(path: string, body: Uint8Array, controller?: AbortController) {
  const bytes = Uint8Array.from(body).buffer;
  const source = new Request(origin + path, { method: "POST", body: bytes });
  return new Request(source.url, {
    method: "POST",
    body: bytes,
    signal: controller?.signal,
    headers: signPrivateRequest(source, body, secret, {
      namespace,
      purpose: "browser",
      siteOrigin: origin,
      ip: "192.0.2.1",
    }),
  });
}

test("allowlist registry retains 4 MiB/300 s only for creation and every old GET has HEAD", () => {
  assert.equal(
    privateRoute("POST", "/api/presale/allowlists", "browser")?.maxBodyBytes,
    4 * 1024 * 1024,
  );
  assert.equal(privateRoute("POST", "/api/presale/allowlists", "browser")?.workBudgetMs, 300000);
  assert.equal(
    privateRoute("POST", "/api/presale/bridge/transfers", "browser")?.workBudgetMs,
    undefined,
  );
  for (const path of [
    "/api/presale/allowlists/a",
    "/api/presale/allowlists/a/entries",
    "/api/presale/presales/a/proof",
    "/api/presale/bridge/quote",
    "/api/presale/bridge/transfers/a",
    "/api/presale/rewards/rounds/a/manifest",
  ]) {
    assert.ok(privateRoute("GET", path, "browser"));
    assert.ok(privateRoute("HEAD", path, "browser"));
  }
});

test("authenticated allowlist slot has no queue and stays owned through actual cancellation settlement", async () => {
  let finish!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  let nativeCallbacks = 0;
  const runtime = createBackendHttp({
    namespace,
    gatewaySecret: secret,
    redis: { execute: async () => "OK" },
    ready: async () => true,
    handle: async () => new Response(),
    privateApi: {
      siteOrigin: origin,
      async handle(request) {
        calls++;
        if (calls === 1) {
          entered();
          await held;
        }
        return new Response(await request.arrayBuffer());
      },
    },
  });
  const consumeStatus = async (response: Response) => {
    const status = response.status;
    await response.arrayBuffer();
    return status;
  };
  const controller = new AbortController();
  const first = runtime.fetch(
    signed("/api/presale/allowlists", new Uint8Array(4 * 1024 * 1024), controller),
    "127.0.0.1",
    0,
    () => {
      nativeCallbacks++;
    },
  );
  await Promise.race([
    started,
    first.then((response) => {
      throw new Error(`Handler did not start: ${response.status}`);
    }),
  ]);
  const bad = signed("/api/presale/allowlists", new Uint8Array());
  bad.headers.set("x-blast-private-signature", "bad");
  assert.equal(
    await consumeStatus(
      await runtime.fetch(bad, "127.0.0.1", 0, () => {
        nativeCallbacks++;
      }),
    ),
    403,
  );
  assert.equal(
    await consumeStatus(
      await runtime.fetch(signed("/api/presale/allowlists", new Uint8Array()), "127.0.0.1"),
    ),
    503,
  );
  controller.abort(new Error("synthetic disconnect"));
  assert.equal(await consumeStatus(await first), 503);
  assert.equal(
    await consumeStatus(
      await runtime.fetch(signed("/api/presale/allowlists", new Uint8Array()), "127.0.0.1"),
    ),
    503,
  );
  assert.equal(
    nativeCallbacks,
    1,
    "invalid proof and exhausted lane never change native socket policy",
  );
  finish();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const answer = await runtime.fetch(
    signed("/api/presale/allowlists", new Uint8Array()),
    "127.0.0.1",
  );
  assert.equal(answer.status, 200);
  await answer.arrayBuffer();
  await runtime.drain();
});

test("native zero idle timeout is applied only after the selected long route authenticates", async () => {
  const runtime = createBackendServer({
    namespace,
    gatewaySecret: secret,
    redis: { execute: async () => "OK" },
    ready: async () => true,
    handle: async () => new Response(),
    privateApi: { siteOrigin: origin, handle: async () => new Response("ok") },
  });
  const original = runtime.server.timeout.bind(runtime.server);
  const seconds: number[] = [];
  runtime.server.timeout = (request, value) => {
    seconds.push(value);
    return original(request, value);
  };
  const send = async (valid: boolean) => {
    const source = signed("/api/presale/allowlists", new Uint8Array());
    if (!valid) {
      source.headers.set("x-blast-private-signature", "bad");
    }
    const response = await fetch(`http://127.0.0.1:${runtime.server.port}/api/presale/allowlists`, {
      method: "POST",
      headers: source.headers,
    });
    await response.arrayBuffer();
    return response.status;
  };
  try {
    assert.equal(await send(false), 403);
    assert.deepEqual(seconds, [40]);
    assert.equal(await send(true), 200);
    assert.deepEqual(seconds, [40, 40, 0]);
  } finally {
    await runtime.drain();
  }
});

test("response completion releases the request independently while a fresh background job retains its provider", async () => {
  const { reserveAfterResponse, trackRequestWork } = await import(
    "@blast/server/lib/request-work.ts"
  );
  let closeBody!: () => void;
  let finishProvider!: () => void;
  let jobStarted = false;
  let drainFinished = false;
  const provider = new Promise<void>((resolve) => {
    finishProvider = resolve;
  });
  const runtime = createBackendHttp({
    namespace,
    gatewaySecret: secret,
    maxInflight: 1,
    redis: { execute: async () => "OK" },
    ready: async () => true,
    handle: async () => new Response(),
    privateApi: {
      siteOrigin: origin,
      async handle() {
        const reserved = reserveAfterResponse();
        assert.ok(reserved);
        reserved.attach(async () => {
          jobStarted = true;
          trackRequestWork(provider);
        });
        return new Response(
          new ReadableStream({
            start(controller) {
              closeBody = () => controller.close();
            },
          }),
        );
      },
    },
  });
  const response = await runtime.fetch(
    signed("/api/presale/allowlists", new Uint8Array()),
    "127.0.0.1",
  );
  assert.equal(jobStarted, false);
  const body = response.arrayBuffer();
  closeBody();
  await body;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(jobStarted, true);
  const live = await runtime.fetch(new Request("http://backend.test/v1/health"), "127.0.0.1");
  assert.equal(live.status, 200, "background work does not retain the request permit");
  await live.arrayBuffer();
  const draining = runtime.drain().then(() => {
    drainFinished = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    drainFinished,
    false,
    "job slot joins the underlying provider after the job returns",
  );
  finishProvider();
  await draining;
});

test("disconnect waits actual handler and body cancellation before starting accepted work during shutdown", async () => {
  const { reserveAfterResponse } = await import("@blast/server/lib/request-work.ts");
  let entered!: () => void, settle!: () => void, cancelBody!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const handler = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const cancellation = new Promise<void>((resolve) => {
    cancelBody = resolve;
  });
  let backgroundStarted = false;
  const runtime = createBackendHttp({
    namespace,
    gatewaySecret: secret,
    redis: { execute: async () => "OK" },
    ready: async () => true,
    handle: async () => new Response(),
    privateApi: {
      siteOrigin: origin,
      async handle() {
        reserveAfterResponse()!.attach(async () => {
          backgroundStarted = true;
        });
        entered();
        await handler;
        return new Response(
          new ReadableStream({
            cancel() {
              return cancellation;
            },
          }),
        );
      },
    },
  });
  const controller = new AbortController();
  const response = runtime.fetch(
    signed("/api/presale/allowlists", new Uint8Array(), controller),
    "127.0.0.1",
  );
  await started;
  controller.abort();
  await (await response).arrayBuffer();
  const draining = runtime.drain();
  assert.equal(backgroundStarted, false);
  settle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(backgroundStarted, false, "async cancellation is actual response work");
  cancelBody();
  await draining;
  assert.equal(backgroundStarted, true, "stopping reservations still starts already accepted work");
});

test("all image families share two authenticated slots through actual body cleanup", async () => {
  let finishCancellation!: () => void;
  const cancellation = new Promise<void>((resolve) => {
    finishCancellation = resolve;
  });
  let calls = 0;
  const runtime = createBackendHttp({
    namespace,
    gatewaySecret: secret,
    redis: { execute: async () => "OK" },
    ready: async () => true,
    handle: async () => new Response(),
    privateApi: {
      siteOrigin: origin,
      async handle() {
        calls++;
        return new Response(
          new ReadableStream({
            cancel() {
              return cancellation;
            },
          }),
        );
      },
    },
  });

  function imageRequest(
    kind: "asset" | "profile" | "sales" | "create-logo" | "create-cover" = "asset",
  ) {
    const path =
      kind === "create-logo"
        ? "/api/social/me/drafts/synthetic-draft/logo"
        : kind === "create-cover"
          ? "/api/social/me/drafts/synthetic-draft/cover"
          : kind === "profile"
            ? "/api/social/me/profile/picture"
            : kind === "sales"
              ? "/api/social/sales/synthetic-sale/cover"
              : "/api/launchpad/launch-assets";
    const method = kind === "profile" || kind === "create-logo" ? "PUT" : "POST";
    const source = new Request(origin + path, {
      method,
      body: new Uint8Array([1]),
    });
    return new Request(source.url, {
      method,
      body: new Uint8Array([1]),
      headers: signPrivateRequest(source, new Uint8Array([1]), secret, {
        namespace,
        purpose: "browser",
        siteOrigin: origin,
        ip: "192.0.2.1",
      }),
    });
  }

  const first = await runtime.fetch(imageRequest(), "127.0.0.1");
  const second = await runtime.fetch(imageRequest("profile"), "127.0.0.1");
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const refused = await runtime.fetch(imageRequest("sales"), "127.0.0.1");
  assert.equal(refused.status, 503);
  await refused.arrayBuffer();

  async function status(response: Response) {
    await response.arrayBuffer();
    return response.status;
  }

  const invalid = imageRequest("profile");
  invalid.headers.set("x-blast-private-signature", "bad");
  assert.equal(await status(await runtime.fetch(invalid, "127.0.0.1")), 403);
  assert.equal(calls, 2);
  const cancelled = first.body!.cancel();
  assert.equal(await status(await runtime.fetch(imageRequest("profile"), "127.0.0.1")), 503);
  for (const kind of ["create-logo", "create-cover"] as const) {
    assert.equal(
      await status(await runtime.fetch(imageRequest(kind), "127.0.0.1")),
      503,
      "Creation images share occupied slots with existing image families",
    );
  }
  finishCancellation();
  await cancelled;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const recovered = await runtime.fetch(imageRequest("sales"), "127.0.0.1");
  assert.equal(recovered.status, 200);
  assert.equal(calls, 3);
  await Promise.all([second.body!.cancel(), recovered.body!.cancel()]);
  await runtime.drain();
});

for (const failure of ["oversize", "abort"] as const) {
  test(`incoming ${failure} retains both image and global slots until actual cancellation settles`, async () => {
    const cancellations: (() => void)[] = [];
    const started: Promise<void>[] = [];
    let business = 0;
    let nonces = 0;
    const runtime = createBackendHttp({
      namespace,
      gatewaySecret: secret,
      maxInflight: 2,
      redis: {
        async execute() {
          nonces++;
          return "OK";
        },
      },
      ready: async () => true,
      handle: async () => new Response(),
      privateApi: {
        siteOrigin: origin,
        async handle() {
          business++;
          return new Response("ok");
        },
      },
    });
    const pending = Array.from({ length: 2 }, () => {
      let cancelStarted!: () => void;
      started.push(
        new Promise<void>((resolve) => {
          cancelStarted = resolve;
        }),
      );
      let finish!: () => void;
      const cancellation = new Promise<void>((resolve) => {
        finish = resolve;
      });
      cancellations.push(finish);
      const controller = new AbortController();
      const path = "/api/launchpad/launch-assets";
      const source = new Request(origin + path, { method: "POST" });
      const body = new ReadableStream<Uint8Array>(
        {
          pull(stream) {
            if (failure === "oversize") {
              stream.enqueue(new Uint8Array(65537));
            } else {
              controller.abort(new Error("synthetic disconnected upload"));
            }
          },
          cancel() {
            cancelStarted();
            return cancellation;
          },
        },
        { highWaterMark: 0 },
      );
      return runtime.fetch(
        new Request(source.url, {
          method: "POST",
          signal: controller.signal,
          body,
          headers: signPrivateRequest(source, new Uint8Array(), secret, {
            namespace,
            purpose: "browser",
            siteOrigin: origin,
            ip: "192.0.2.1",
          }),
          duplex: "half",
        } as RequestInit),
        "127.0.0.1",
      );
    });

    async function status(response: Response) {
      await response.arrayBuffer();
      return response.status;
    }

    try {
      await Promise.all(started);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        await status(
          await runtime.fetch(
            signed("/api/launchpad/launch-assets", new Uint8Array()),
            "127.0.0.1",
          ),
        ),
        503,
        "image slots remain owned",
      );
      assert.equal(
        await status(
          await runtime.fetch(new Request("http://backend.test/api/v1/market/status"), "127.0.0.1"),
        ),
        503,
        "global slots remain owned",
      );
      assert.equal(business, 0);
      assert.equal(nonces, 0);
      cancellations[0]();
      assert.equal(await status(await pending[0]), failure === "oversize" ? 413 : 503);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        await status(
          await runtime.fetch(
            signed("/api/launchpad/launch-assets", new Uint8Array()),
            "127.0.0.1",
          ),
        ),
        200,
      );
      assert.equal(business, 1);
    } finally {
      for (const release of cancellations) {
        release();
      }
      for (const request of pending) {
        const response = await request;
        if (!response.bodyUsed) {
          await response.arrayBuffer();
        }
      }
      await runtime.drain();
    }
  });
}
