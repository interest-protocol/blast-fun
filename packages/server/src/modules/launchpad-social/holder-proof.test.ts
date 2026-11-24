import assert from "node:assert/strict";
import test from "node:test";
import { snapshotHolderProof } from "./holder-proof.ts";
import {
  createAfterResponseScheduler,
  createRequestWork,
  runWithRequestWork,
} from "@blast/server/lib/request-work.ts";
import type { HoldersSnapshotPage } from "@blast/core/modules/launchpad-contract/holders.ts";
import type { V1Answer } from "@blast/core/modules/launchpad-contract/v1.ts";
import type { RoutedRead } from "@blast/core/modules/launchpad-contract/read.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const unavailable = {
  status: "unavailable",
  provenance: {
    source: "blast-infra",
    network: null,
    deployment: null,
    checkpoint: null,
    timestampMs: null,
    observedAt: 0,
    lagMs: null,
  },
} as const;
type Page = RoutedRead<V1Answer<HoldersSnapshotPage>>;

test("holder proof visible deadline retains the actual pending page until it settles", async () => {
  const page = deferred<Page>();
  const work = createRequestWork(createAfterResponseScheduler());
  let pages = 0;
  const proof = snapshotHolderProof({
    coinTypeOf: async () => "0x2::sui::SUI",
    readPage: () => {
      pages++;
      return page.promise;
    },
    maxPages: 10,
    deadlineMs: 15,
    trackWork: work.track,
  });
  assert.deepEqual(
    await runWithRequestWork(work, () => proof.prove("launch", "wallet")),
    { verification: "unavailable" },
  );
  assert.equal(pages, 1);
  let complete = false;
  const ending = work.complete().then(() => {
    complete = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(complete, false);
  page.resolve(unavailable);
  await ending;
  assert.equal(complete, true);
  assert.equal(pages, 1);
});

test("expired request starts neither coin lookup nor later holder pages", async () => {
  const controller = new AbortController();
  const work = createRequestWork(createAfterResponseScheduler());
  let coins = 0;
  let pages = 0;
  const coin = deferred<string | null>();
  const proof = snapshotHolderProof({
    coinTypeOf: () => {
      coins++;
      return coin.promise;
    },
    readPage: async () => {
      pages++;
      return unavailable;
    },
    maxPages: 10,
    deadlineMs: 100,
    trackWork: work.track,
  });
  controller.abort();
  assert.deepEqual(
    await runWithRequestWork(
      work,
      () => proof.prove("launch", "wallet"),
      controller.signal,
    ),
    { verification: "unavailable" },
  );
  assert.equal(coins, 0);
  const later = new AbortController();
  const pending = runWithRequestWork(
    work,
    () => proof.prove("launch", "wallet"),
    later.signal,
  );
  later.abort();
  coin.resolve("0x2::sui::SUI");
  assert.deepEqual(await pending, { verification: "unavailable" });
  assert.equal(coins, 1);
  assert.equal(pages, 0);
  await work.complete();
});
