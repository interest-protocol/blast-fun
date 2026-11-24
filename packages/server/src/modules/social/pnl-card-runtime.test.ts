import assert from "node:assert/strict";
import test from "node:test";
import { parsePnlCardPage } from "@blast/core/modules/social/contracts/pnl-card-sharing.ts";
import {
  createPnlCardImageRoute,
  createPnlCardPageRoute,
} from "./pnl-card-runtime.ts";
import { testClient } from "../../../../core/test/fixtures/lib/web-security/client-address.ts";

const id = "a".repeat(64);

test("PnL public image preserves bytes, headers and rate-before-read admission", async () => {
  let reads = 0;
  const bytes = Buffer.from("original snapshot bytes");
  const route = createPnlCardImageRoute(
    async (key) => {
      reads++;
      assert.equal(key, id);
      return bytes;
    },
    async (_client, buckets, work) => {
      assert.deepEqual(buckets, ["mission_control_card_image"]);
      return work();
    },
  );
  const response = await route(testClient(), id);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("content-length"), String(bytes.length));
  assert.equal(
    response.headers.get("cache-control"),
    "public, max-age=31536000, immutable",
  );
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal(reads, 1);
  const denied = createPnlCardImageRoute(
    async () => {
      reads++;
      return bytes;
    },
    async () => new Response(null, { status: 429 }),
  );
  assert.equal(
    (await denied(testClient(), id)).status,
    429,
  );
  assert.equal(reads, 1);
});

test("PnL page transfers existence only, preserving absent and unavailable distinctions", async () => {
  const route = createPnlCardPageRoute(async () =>
    Buffer.from("private pixels"),
  );
  const response = await route(id);
  assert.deepEqual(parsePnlCardPage(await response.text(), id), {
    id,
    exists: true,
  });
  assert.deepEqual(
    await (await createPnlCardPageRoute(async () => null)(id)).json(),
    { id, exists: false },
  );
  await assert.rejects(
    createPnlCardPageRoute(async () => {
      throw new Error("store unavailable");
    })(id),
  );
  for (const value of [
    { id, exists: true, bytes: "private" },
    { id: "b".repeat(64), exists: true },
    { id, exists: "true" },
  ]) {
    assert.throws(() => parsePnlCardPage(JSON.stringify(value), id));
  }
});
