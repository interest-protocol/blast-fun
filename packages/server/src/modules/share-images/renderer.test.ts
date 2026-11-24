import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setTimeout as pause } from "node:timers/promises";
import test from "node:test";
import sharp from "sharp";
import { createAfterResponseScheduler, createRequestWork, runWithRequestWork } from "@blast/server/lib/request-work.ts";
import { createPresaleReceiptLogo } from "@blast/core/modules/mission-control/card-renderer/presale-receipt.ts";
import { fixtureDetail } from "../../../../core/test/fixtures/presale-pages/presale-fixtures.ts";
import { renderPresaleSharePng } from "../presale/share/image.ts";
import { renderReferralSharePng } from "../social/referrals/share-image.ts";
import { checkedSharePng, createShareImageExecutor, renderShareImage, validatePnlImage, PNL_VALIDATION_INPUT_BYTES, SHARE_RENDER_INPUT_BYTES, type ShareRenderJob } from "./renderer.ts";

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const inviter = { callsign: "new_friend", crew: null, title: null, avatarUrl: null };
const job: ShareRenderJob = { kind: "referral", inviter, avatar: null };

class ControlledWorker extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  terminated = 0;
  private settlement: Promise<void>;
  constructor(settlement = Promise.resolve()) {
    super();
    this.settlement = settlement;
  }
  async terminate() {
    this.terminated++;
    await this.settlement;
    this.stdout.destroy();
    this.stderr.destroy();
    return 0;
  }
}

test("PNL and render jobs share two slots through actual successful termination", async () => {
  let release!: () => void;
  const settlement = new Promise<void>((resolve) => { release = resolve; });
  const workers: ControlledWorker[] = [];
  const execute = createShareImageExecutor({ worker() {
    const worker = new ControlledWorker(settlement); workers.push(worker); return worker;
  } });
  const validation = execute({ kind: "pnl-validate", bytes: png });
  const render = execute(job);
  workers[0]!.emit("message", true);
  workers[1]!.emit("message", png);
  await pause(1);
  try {
    await assert.rejects(execute(job), /busy/);
    await assert.rejects(execute({ kind: "pnl-validate", bytes: png }), /busy/);
    assert.equal(workers.length, 2);
    assert.equal(workers[0]!.terminated, 1);
    assert.equal(workers[1]!.terminated, 1);
  } finally { release(); }
  assert.equal(await validation, true);
  assert.deepEqual(await render, Buffer.from(png));
});

test("PNL timeout retains its shared slot until physical termination", async () => {
  let release!: () => void;
  const settlement = new Promise<void>((resolve) => { release = resolve; });
  const workers: ControlledWorker[] = [];
  const execute = createShareImageExecutor({ timeoutMs: 10, worker() {
    const worker = new ControlledWorker(settlement); workers.push(worker); return worker;
  } });
  const validation = execute({ kind: "pnl-validate", bytes: png }).catch((error: Error) => error);
  const render = execute(job).catch((error: Error) => error);
  try {
    await pause(25);
    await assert.rejects(execute({ kind: "pnl-validate", bytes: png }), /busy/);
    assert.ok(workers.every((worker) => worker.terminated === 1));
  } finally { release(); }
  assert.match(String(await validation), /cancelled/);
  assert.match(String(await render), /cancelled/);
});

test("PNL absolute abort remains an error and holds capacity until actual exit", async () => {
  let release!: () => void;
  const settlement = new Promise<void>((resolve) => { release = resolve; });
  const controller = new AbortController();
  const scope = createRequestWork(createAfterResponseScheduler());
  const workers: ControlledWorker[] = [];
  const execute = createShareImageExecutor({ worker() {
    const worker = new ControlledWorker(settlement); workers.push(worker); return worker;
  } });
  const validation = runWithRequestWork(scope, () => execute({ kind: "pnl-validate", bytes: png }), controller.signal)
    .catch((error: Error) => error);
  const render = execute(job);
  controller.abort();
  workers[1]!.emit("message", png);
  try {
    await pause(1);
    await assert.rejects(execute(job), /busy/);
    await assert.rejects(runWithRequestWork(scope, () => execute({ kind: "pnl-validate", bytes: png }), controller.signal));
    assert.equal(workers.length, 2);
  } finally { release(); }
  assert.match(String(await validation), /cancelled/, "abort is not an invalid-image false result");
  assert.deepEqual(await render, Buffer.from(png));
  await scope.complete();
});

test("PNL clones only its owned four-MiB view and rejects mismatched replies", async () => {
  const backing = Buffer.alloc(PNL_VALIDATION_INPUT_BYTES + 64, 7);
  const view = backing.subarray(32, 32 + PNL_VALIDATION_INPUT_BYTES);
  let seen: Uint8Array | undefined;
  let starts = 0;
  const execute = createShareImageExecutor({ worker(candidate) {
    starts++;
    assert.equal(candidate.kind, "pnl-validate");
    if (candidate.kind === "pnl-validate") seen = candidate.bytes;
    const worker = new ControlledWorker();
    queueMicrotask(() => worker.emit("message", true));
    return worker;
  } });
  assert.equal(await execute({ kind: "pnl-validate", bytes: view }), true);
  assert.equal(seen!.byteOffset, 0);
  assert.equal(seen!.buffer.byteLength, PNL_VALIDATION_INPUT_BYTES);
  assert.notEqual(seen!.buffer, backing.buffer);
  assert.deepEqual(view, Buffer.alloc(PNL_VALIDATION_INPUT_BYTES, 7));
  await assert.rejects(execute({ kind: "pnl-validate", bytes: backing }), /envelope/);
  assert.equal(starts, 1);
  const mismatch = createShareImageExecutor({ worker() {
    const worker = new ControlledWorker();
    queueMicrotask(() => worker.emit("message", png));
    return worker;
  } });
  await assert.rejects(mismatch({ kind: "pnl-validate", bytes: png }), /unavailable/);
});

test("real PNL decoder accepts exact original pixels and refuses wrong or truncated images", async () => {
  const original = await sharp({ create: { width: 1200, height: 675, channels: 4, background: "#124567" } }).png().toBuffer();
  const before = Buffer.from(original);
  assert.equal(await validatePnlImage(original), true);
  assert.deepEqual(original, before, "the parent hashes and uploads the unchanged original bytes");
  assert.equal(await validatePnlImage(await sharp(original).resize(1199, 675).png().toBuffer()), false);
  assert.equal(await validatePnlImage(await sharp(original).jpeg().toBuffer()), false);
  assert.equal(await validatePnlImage(original.subarray(0, 50)), false);
  assert.equal(await validatePnlImage(new Uint8Array()), false);
  const multipage = await sharp(Buffer.alloc(1200 * 675 * 4 * 2), {
    raw: { width: 1200, height: 1350, channels: 4, pageHeight: 675 },
  }).tiff().toBuffer();
  assert.equal((await sharp(multipage, { animated: true }).metadata()).pages, 2);
  assert.equal(await validatePnlImage(multipage), false);
});

test("public render and PNL helper exports use the same production singleton", async () => {
  const first = renderShareImage(job);
  const second = renderShareImage(job);
  await assert.rejects(validatePnlImage(png), /busy/);
  await Promise.all([first, second]);
});

test("two shared render slots survive timeout until actual termination; no queued work", async () => {
  let release!: () => void;
  const settlement = new Promise<void>((resolve) => { release = resolve; });
  const workers: ControlledWorker[] = [];
  const execute = createShareImageExecutor({ timeoutMs: 10, worker() {
    const worker = new ControlledWorker(settlement); workers.push(worker); return worker;
  } });
  const first = execute(job).catch((error: Error) => error);
  const second = execute(job).catch((error: Error) => error);
  try {
    await pause(30);
    assert.equal(workers[0].terminated, 1);
    assert.equal(workers[1].terminated, 1);
    await assert.rejects(execute(job), { message: "Share render busy" });
    assert.equal(workers.length, 2);
  } finally { release(); await Promise.all([first, second]); }
  const third = execute(job);
  workers[2].emit("message", png);
  assert.deepEqual(await third, Buffer.from(png));
});

test("successful replies retain both family slots until worker termination settles", async () => {
  let release!: () => void;
  const settlement = new Promise<void>((resolve) => { release = resolve; });
  const workers: ControlledWorker[] = [];
  const execute = createShareImageExecutor({ worker() { const worker = new ControlledWorker(settlement); workers.push(worker); return worker; } });
  let completed = 0;
  const first = execute(job).then(() => { completed++; });
  const second = execute({ kind: "presale", sale: fixtureDetail("mrdn").presale, artwork: { logo: null, cover: null } }).then(() => { completed++; });
  workers.forEach((worker) => worker.emit("message", png));
  try {
    await pause(5);
    assert.equal(completed, 0);
    await assert.rejects(execute(job), { message: "Share render busy" });
  } finally { release(); await Promise.all([first, second]); }
  assert.equal(completed, 2);
});

test("absolute request abort terminates active workers; preabort creates none", async () => {
  const controller = new AbortController();
  const scope = createRequestWork(createAfterResponseScheduler());
  const workers: ControlledWorker[] = [];
  const execute = createShareImageExecutor({ worker() {
    const worker = new ControlledWorker(); workers.push(worker); return worker;
  } });
  const result = runWithRequestWork(scope, () => execute(job), controller.signal);
  controller.abort();
  await assert.rejects(result, { message: "Share render cancelled" });
  await assert.rejects(runWithRequestWork(scope, () => execute(job), controller.signal));
  assert.equal(workers.length, 1);
  assert.equal(workers[0].terminated, 1);
  await scope.complete();
});

test("constructor failure, worker failure, early exit and invalid output release only after cleanup", async () => {
  const unavailable = createShareImageExecutor({ worker() { throw new Error("Constructor failed"); } });
  for (let attempt = 0; attempt < 3; attempt++) await assert.rejects(unavailable(job), /Constructor failed/);
  for (const event of ["error", "exit", "message"] as const) {
    const workers: ControlledWorker[] = [];
    const execute = createShareImageExecutor({ worker() { const worker = new ControlledWorker(); workers.push(worker); return worker; } });
    for (let attempt = 0; attempt < 3; attempt++) {
      const pending = execute(job);
      const worker = workers.at(-1)!;
      worker.emit(event, event === "error" ? new Error("Worker failed") : event === "message" ? new Uint8Array(10) : 0);
      await assert.rejects(pending);
      assert.equal(worker.terminated, 1);
    }
  }
});

test("input envelopes preserve two existing 4MiB artwork values and reject oversized DTO or job before spawning", async () => {
  let starts = 0;
  let worker!: ControlledWorker;
  const execute = createShareImageExecutor({ worker() { starts++; return worker = new ControlledWorker(); } });
  const sale = fixtureDetail("mrdn").presale;
  const artwork = { sha256: "a".repeat(64), bytes: "a".repeat(Math.ceil(4 * 1024 * 1024 / 3) * 4) };
  const accepted: ShareRenderJob = { kind: "presale", sale, artwork: { logo: artwork, cover: artwork } };
  assert.ok(Buffer.byteLength(JSON.stringify(accepted)) < SHARE_RENDER_INPUT_BYTES);
  const pending = execute(accepted); worker.emit("message", png); await pending;
  await assert.rejects(execute({ ...job, inviter: { ...inviter, callsign: "a".repeat(1024 * 1024) } }), /input exceeds/);
  await assert.rejects(execute({ ...job, avatar: { ...artwork, bytes: "a".repeat(SHARE_RENDER_INPUT_BYTES) } }), /input exceeds/);
  assert.equal(starts, 1);
  for (const invalid of [new Uint8Array(), new Uint8Array(9 * 1024 * 1024), "png", {}]) assert.throws(() => checkedSharePng(invalid));
});

test("actual Bun workers preserve authoritative presale and ranked/unranked referral PNGs", async () => {
  const execute = createShareImageExecutor();
  const logo = createPresaleReceiptLogo(await sharp({ create: { width: 64, height: 32, channels: 4, background: "#ff4c98" } }).png().toBuffer());
  const sale = fixtureDetail("mrdn").presale;
  const artwork = { logo, cover: logo };
  const expected = await renderPresaleSharePng(sale, artwork);
  const actual = await execute({ kind: "presale", sale, artwork });
  assert.deepEqual(actual, expected);
  assert.deepEqual([(await sharp(actual).metadata()).width, (await sharp(actual).metadata()).height], [1200, 675]);
  for (const who of [inviter, { ...inviter, callsign: "ranked_member", crew: 21, title: "Flight Director" }]) {
    const direct = await renderReferralSharePng(who, logo);
    const isolated = await execute({ kind: "referral", inviter: who, avatar: logo });
    assert.deepEqual(isolated, direct);
    const metadata = await sharp(isolated).metadata();
    assert.deepEqual([metadata.format, metadata.width, metadata.height], ["png", 1200, 675]);
  }
});
