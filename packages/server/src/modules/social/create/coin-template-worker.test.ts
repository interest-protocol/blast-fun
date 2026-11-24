import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { setTimeout as pause } from "node:timers/promises";
import { BLAST_DEPLOYMENTS, presaleDeployment } from "@interest-protocol/blast-sdk/deployments";
import { buildPresaleCoinPackageBytecode } from "@interest-protocol/blast-sdk/presale";
import { toBase64 } from "@mysten/sui/utils";
import { createAfterResponseScheduler, createRequestWork, runWithRequestWork } from "@blast/server/lib/request-work.ts";
import { createCoinTemplateExecutor } from "./coin-template.ts";

const deployment = presaleDeployment(BLAST_DEPLOYMENTS.mainnet!);
const coin = { name: "Meridian", symbol: "MRDN", description: "Representative local SDK fixture", iconUrl: "https://fixture.invalid/processed.webp", decimals: 9 };
const hanging = new URL("data:text/javascript,setInterval(()=>{},1000)");

test("isolated bytecode equals the authoritative SDK for typical and maximum model metadata", async () => {
  // Production's 4 s budget includes the cold Worker start; a loaded test host needs more, and a pass returns as soon as the build does.
  const bytecode = createCoinTemplateExecutor({ timeoutMs: 60_000 });
  for (const metadata of [coin, { ...coin, name: "🚀".repeat(16), symbol: "ABCDEFGHIJ", description: "🚀".repeat(40), iconUrl: "https://fixture.invalid/" + "a".repeat(480) }]) {
    const expected = await buildPresaleCoinPackageBytecode({ ...metadata, metadataCapRecipient: null }, deployment);
    const actual = await bytecode(metadata, deployment);
    assert.equal(actual.modules[0], toBase64(expected));
    assert.ok(Buffer.byteLength(JSON.stringify(actual)) < 1024 * 1024);
  }
});

test("bytecode timeout holds both slots until actual worker termination settles", async () => {
  let release!: () => void;
  const settlement = new Promise<void>((resolve) => { release = resolve; });
  let starts = 0;
  const execute = createCoinTemplateExecutor({ timeoutMs: 20, worker() {
    starts++;
    const worker = new Worker(hanging, { env: {}, stdout: true, stderr: true });
    const terminate = worker.terminate.bind(worker);
    worker.terminate = async () => { const code = await terminate(); await settlement; return code; };
    return worker;
  } });
  const first = execute(coin, deployment).catch((error: Error) => error);
  const second = execute(coin, deployment).catch((error: Error) => error);
  try {
    await pause(60);
    await assert.rejects(execute(coin, deployment), { message: "Coin bytecode busy" });
    assert.equal(starts, 2);
  } finally { release(); await Promise.all([first, second]); }
  await assert.rejects(execute(coin, deployment), { message: "Coin bytecode cancelled" });
  assert.equal(starts, 3);
});

test("absolute abort stops an active worker and already-aborted requests start no worker", async () => {
  const controller = new AbortController();
  const scope = createRequestWork(createAfterResponseScheduler());
  let starts = 0;
  const execute = createCoinTemplateExecutor({ worker() {
    starts++;
    return new Worker(hanging, { env: {}, stdout: true, stderr: true });
  } });
  const pending = runWithRequestWork(scope, () => execute(coin, deployment), controller.signal);
  controller.abort();
  await assert.rejects(pending, { message: "Coin bytecode cancelled" });
  await assert.rejects(runWithRequestWork(scope, () => execute(coin, deployment), controller.signal));
  assert.equal(starts, 1);
  await scope.complete();
});

test("unexpected worker exit and invalid cloned output fail closed without leaving occupied slots", async () => {
  for (const source of ["", "import{parentPort}from'node:worker_threads';parentPort.postMessage({modules:[],dependencies:[]})"]) {
    const execute = createCoinTemplateExecutor({ worker: () => new Worker(new URL("data:text/javascript," + encodeURIComponent(source)), { env: {}, stdout: true, stderr: true }) });
    for (let attempt = 0; attempt < 3; attempt++) await assert.rejects(execute(coin, deployment));
  }
});
