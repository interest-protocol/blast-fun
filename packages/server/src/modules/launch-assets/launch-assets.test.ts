import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";
import sharp from "sharp";

import {
  LAUNCH_IMAGE_MAX_BYTES,
  sniffLaunchImage,
} from "@blast/core/lib/launchpad/launch-image.ts";
import type { RateLimitPort } from "@blast/core/lib/web-security/rate-limits.ts";
import type { LaunchpadIdentity } from "@blast/server/modules/launchpad-identity/mutation.ts";
import {
  launchAssetHandler,
  sanitizeLaunchImage,
  type LaunchAssetStore,
} from "./index.ts";
import { testClient } from "../../../../core/test/fixtures/lib/web-security/client-address.ts";

const ORIGIN = "https://blast.fun";
const CSRF = "c".repeat(43);

function solid(width: number, height: number) {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 40, b: 90 },
    },
  });
}

async function noise(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let index = 0; index < raw.length; index += 1)
    raw[index] = (index * 7919 + (index >> 3) * 104729) % 256;
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toBuffer();
}

test("PNG, JPEG, and WebP within the configured limits are re-encoded without metadata", async () => {
  const cases = [
    ["image/png", await solid(256, 256).png().toBuffer()],
    [
      "image/jpeg",
      await solid(256, 256)
        .jpeg()
        .withMetadata({ exif: { IFD0: { Copyright: "fixture" } } })
        .toBuffer(),
    ],
    ["image/webp", await solid(256, 128).webp().toBuffer()],
  ] as const;
  for (const [contentType, bytes] of cases) {
    const result = await sanitizeLaunchImage(bytes, contentType);
    assert.equal(result.ok, true, contentType);
    if (!result.ok) continue;
    assert.equal(result.image.contentType, contentType);
    const metadata = await sharp(result.image.bytes).metadata();
    assert.equal(metadata.exif, undefined, `${contentType} keeps no EXIF`);
    assert.equal(metadata.width, result.image.width);
    assert.equal(metadata.height, result.image.height);
  }
});

test("active content, other formats, mismatched types, and oversize or odd images are rejected", async () => {
  const png = await solid(128, 128).png().toBuffer();
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="10" height="10"/></svg>',
  );
  const gif = await solid(128, 128).gif().toBuffer();
  const animated = await sharp(
    [
      await solid(64, 64).png().toBuffer(),
      await sharp({
        create: {
          width: 64,
          height: 64,
          channels: 3,
          background: { r: 0, g: 0, b: 255 },
        },
      })
        .png()
        .toBuffer(),
    ],
    { join: { animated: true } },
  )
    .webp({ loop: 0, delay: [100, 100] })
    .toBuffer();
  const cases: Array<[string, Buffer, string, string]> = [
    ["svg declared as svg", svg, "image/svg+xml", "unsupported-type"],
    ["svg declared as png", svg, "image/png", "type-mismatch"],
    [
      "html",
      Buffer.from("<!DOCTYPE html><script>alert(1)</script>"),
      "image/png",
      "type-mismatch",
    ],
    [
      "png with a script appended",
      Buffer.concat([png, Buffer.from("<script>alert(1)</script>")]),
      "image/png",
      "active-content",
    ],
    ["gif", gif, "image/gif", "unsupported-type"],
    [
      "jpeg declared as png",
      await solid(128, 128).jpeg().toBuffer(),
      "image/png",
      "type-mismatch",
    ],
    [
      "corrupt png",
      Buffer.concat([png.subarray(0, 16), Buffer.alloc(64, 7)]),
      "image/png",
      "undecodable",
    ],
    [
      "too small",
      await solid(32, 32).png().toBuffer(),
      "image/png",
      "dimensions",
    ],
    [
      "too wide",
      await solid(1_100, 80).png().toBuffer(),
      "image/png",
      "dimensions",
    ],
    ["animated", animated, "image/webp", "animated"],
    ["too large", await noise(256, 256), "image/png", "too-large"],
  ];
  for (const [label, bytes, declared, reason] of cases) {
    const result = await sanitizeLaunchImage(bytes, declared);
    assert.deepEqual(result, { ok: false, reason }, label);
  }
  assert.ok((await noise(256, 256)).length > LAUNCH_IMAGE_MAX_BYTES);
  assert.deepEqual(sniffLaunchImage(svg, "image/png"), {
    ok: false,
    reason: "type-mismatch",
  });
});

class Probe {
  readonly touched: string[] = [];
  readonly writes: Array<{
    pathname: string;
    contentType: string;
    bytes: number;
  }> = [];
  storeUrl = "https://assets.blast.test";

  readonly pool = {
    connect: async () => ({
      query: async (sql: unknown) => {
        const command = String(
          typeof sql === "string" ? sql : (sql as { text?: string }).text,
        ).split(" ")[0];
        this.touched.push(`sql:${command}`);
        return { rows: [], rowCount: 0, command };
      },
      release: () => undefined,
      on: () => undefined,
      removeListener: () => undefined,
    }),
  } as unknown as Pool;

  readonly limiter: RateLimitPort = {
    consume: async (bucket) => {
      this.touched.push(`limiter:${bucket}`);
      return { allowed: true, bucket, policyVersion: 1, retryAfterSeconds: 0 };
    },
  };

  readonly identity: LaunchpadIdentity = {
    authenticatePrivy: async () => ({
      method: "privy",
      subjectKey: "k".repeat(64),
      walletAddress: null,
    }),
    checkWalletProof: async () => {
      throw new Error("unused");
    },
    consumeWalletProof: async () => {
      throw new Error("unused");
    },
  };

  readonly store: LaunchAssetStore = {
    write: async (pathname, bytes, contentType) => {
      this.touched.push("store");
      this.writes.push({ pathname, contentType, bytes: bytes.length });
      return { url: `${this.storeUrl}/${pathname}` };
    },
  };

  handler(store: LaunchAssetStore | null = this.store) {
    return launchAssetHandler(store, {
      expectedOrigin: ORIGIN,
      identity: this.identity,
      limiter: this.limiter,
      pool: this.pool,
      createRequestId: () => "request-fixture",
    });
  }
}

function upload(input: Record<string, unknown>): Request {
  return new Request(`${ORIGIN}/api/launchpad/launch-assets`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      cookie: `__Host-blast_csrf=${CSRF}`,
      "x-blast-csrf": CSRF,
      "content-type": "application/json",
      authorization: "Bearer header.payload.signature",
    },
    body: JSON.stringify({ input }),
  });
}

test("a protected upload stores a safe image once at its content address and returns its https reference", async () => {
  const probe = new Probe();
  const bytes = await solid(256, 256).png().toBuffer();
  const response = await probe.handler()(
    upload({ contentType: "image/png", data: bytes.toString("base64") }), testClient(),
  );
  assert.equal(response.status, 201);
  const body = (await response.json()) as { asset: Record<string, unknown> };
  const stored = probe.writes[0]!;
  assert.match(stored.pathname, /^launch-assets\/[0-9a-f]{64}\.png$/);
  assert.deepEqual(body.asset, {
    url: `https://assets.blast.test/${stored.pathname}`,
    sha256: stored.pathname.slice("launch-assets/".length, -4),
    contentType: "image/png",
    width: 256,
    height: 256,
    bytes: stored.bytes,
  });
  assert.ok(probe.touched.includes("limiter:launchpad_launch_asset"));
  const firstStatement = probe.touched.findIndex((entry) =>
    entry.startsWith("sql:"),
  );
  assert.ok(
    probe.touched.indexOf("store") < firstStatement,
    "the decode and the Blob write finish before the database transaction opens",
  );

  const again = await probe.handler()(
    upload({ contentType: "image/png", data: bytes.toString("base64") }), testClient(),
  );
  assert.deepEqual(
    ((await again.json()) as { asset: unknown }).asset,
    body.asset,
  );
  assert.equal(probe.writes[1]?.pathname, stored.pathname);
});

test("a rejected image, a malformed body, or unavailable storage stores nothing", async () => {
  const probe = new Probe();
  const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString(
    "base64",
  );
  const png = (await solid(128, 128).png().toBuffer()).toString("base64");
  const cases: Array<[string, Request, number, LaunchAssetStore | null]> = [
    ["svg", upload({ contentType: "image/png", data: svg }), 400, probe.store],
    [
      "not base64",
      upload({ contentType: "image/png", data: "not base64!" }),
      400,
      probe.store,
    ],
    [
      "extra field",
      upload({ contentType: "image/png", data: png, name: "x" }),
      400,
      probe.store,
    ],
    [
      "undecodable",
      upload({
        contentType: "image/png",
        data: Buffer.concat([
          Buffer.from(png, "base64").subarray(0, 16),
          Buffer.alloc(40, 1),
        ]).toString("base64"),
      }),
      400,
      probe.store,
    ],
    ["no storage", upload({ contentType: "image/png", data: png }), 503, null],
  ];
  for (const [label, request, status, store] of cases) {
    const response = await probe.handler(store)(request, testClient());
    assert.equal(response.status, status, label);
  }
  assert.equal(probe.writes.length, 0);
  assert.equal(
    probe.touched.filter((entry) => entry.startsWith("sql:")).length,
    0,
    "a refused or unstorable image never opens a database transaction",
  );

  probe.storeUrl = "http://assets.blast.test";
  const insecure = await probe.handler()(
    upload({ contentType: "image/png", data: png }), testClient(),
  );
  assert.equal(
    insecure.status,
    503,
    "a store that answers without https gives no official reference",
  );
});
