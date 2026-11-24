import assert from "node:assert/strict";
import test from "node:test";
import {
  createApprovedXAvatarSnapshot,
  createSeasonZeroCardRecord,
} from "@blast/core/modules/mission-control/card-renderer/contract.ts";
import { publicCardImagePath } from "@blast/core/modules/mission-control/card-images/contracts.ts";
import {
  createCardPageRoute,
  createPublicCardImageRoute,
} from "./public-runtime.ts";
import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";

const id = "01234567-89ab-4cde-8fab-0123456789ab";

test("canonical redirect precedes rate admission and renderer resolution", async () => {
  let limits = 0;
  let images = 0;
  let allowed = false;
  const route = createPublicCardImageRoute({
    limit: async (_client, buckets, work) => {
      limits++;
      assert.deepEqual(buckets, ["mission_control_card_image"]);
      return allowed ? work() : new Response(null, { status: 429 });
    },
    image: async (cardId, format, total) => {
      images++;
      assert.deepEqual([cardId, format, total], [id, "share", 3]);
      return new Response("original image");
    },
  });
  const redirected = await route(
    new Request(`https://frontend.test/card/${id}/image?unknown=1`),
    testClient(),
    id,
  );
  assert.equal(redirected.status, 307);
  assert.equal(redirected.headers.get("location"), publicCardImagePath(id));
  assert.equal(limits, 0);
  assert.equal(images, 0);
  const request = () =>
    new Request("https://frontend.test" + publicCardImagePath(id, "share", 3));
  assert.equal((await route(request(), testClient(), id)).status, 429);
  assert.equal(images, 0);
  allowed = true;
  assert.equal(await (await route(request(), testClient(), id)).text(), "original image");
  assert.equal(images, 1);
  assert.equal(limits, 2);
});

test("SSR card owner returns only published minimal fields and propagates outages", async () => {
  const record = createSeasonZeroCardRecord({
    cardId: id,
    callsign: "A.B-c",
    crew: 7,
    title: "CAPCOM",
    avatar: createApprovedXAvatarSnapshot(
      Buffer.from("private-avatar-fixture"),
      "image/png",
    ),
  });
  const route = createCardPageRoute(async (cardId) => {
    assert.equal(cardId, id);
    return { record, recruitHandles: ["private_handle"], recruitTotal: 5 };
  });
  const response = await route(id);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), {
    cardId: id,
    callsign: "A.B-c",
    crew: 7,
    recruitTotal: 5,
  });
  assert.equal(
    await (await createCardPageRoute(async () => null)(id)).text(),
    "null",
  );
  await assert.rejects(
    createCardPageRoute(async () => {
      throw new Error("database unavailable");
    })(id),
  );
});
