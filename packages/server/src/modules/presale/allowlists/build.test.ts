import assert from "node:assert/strict";
import test from "node:test";
import { buildAllowlist } from "@interest-protocol/blast-sdk/presale";
import { buildAllowlistOffThread } from "./build.ts";

const entries = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    wallet: `0x${(index + 1).toString(16).padStart(64, "0")}`,
    walletCap: 1n,
  }));

test("owned worker preserves SDK root, order and every proof without blocking account work", async () => {
  const small = entries(3);
  assert.deepEqual(
    await buildAllowlistOffThread(small, new AbortController().signal),
    buildAllowlist(small),
  );
  const pending = buildAllowlistOffThread(
    entries(4096),
    new AbortController().signal,
  );
  await assert.rejects(
    buildAllowlistOffThread(small, new AbortController().signal),
    { code: "service_unavailable" },
  );
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
  }, 5);
  try {
    const built = await pending;
    assert.equal(built.leafCount, 4096n);
    assert.equal(built.proofs.length, 4096);
    assert.ok(
      ticks > 1,
      "the owning event loop continues serving work during SDK computation",
    );
  } finally {
    clearInterval(timer);
  }
});

test("aborted build awaits worker termination and makes the single slot reusable", async () => {
  const controller = new AbortController();
  const pending = buildAllowlistOffThread(entries(4096), controller.signal);
  controller.abort(new Error("synthetic cancellation"));
  await assert.rejects(pending, /synthetic cancellation/);
  const built = await buildAllowlistOffThread(
    entries(2),
    new AbortController().signal,
  );
  assert.equal(built.leafCount, 2n);
});
