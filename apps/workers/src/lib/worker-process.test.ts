import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";

import { runWorkerProcess } from "./worker-process.ts";

const PROCESS_MODULE = new URL("./worker-process.ts", import.meta.url).href;
const args = (body: string) => ["--no-warnings", "--input-type=module", "--eval", `
  import { runWorkerProcess } from ${JSON.stringify(PROCESS_MODULE)};
  ${body}
`];

test("a completed worker removes its process handlers", async () => {
  const events = ["SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection"] as const;
  const before = events.map((event) => process.listenerCount(event));
  await runWorkerProcess("worker", [], async (signal) => assert.equal(signal.aborted, false));
  assert.deepEqual(events.map((event) => process.listenerCount(event)), before);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`${signal} aborts the worker and waits for its cleanup`, { timeout: 5_000 }, async (context) => {
    const child = spawn(process.execPath, args(`
      await runWorkerProcess("worker", [], async (signal) => {
        const timer = setInterval(() => {}, 1_000);
        try {
          await new Promise((resolve) => {
            signal.addEventListener("abort", resolve, { once: true });
            console.log("ready");
          });
          await new Promise((resolve) => setTimeout(resolve, 20));
          console.log("closed");
        } finally { clearInterval(timer); }
      });
    `));
    context.after(() => child.kill("SIGKILL"));
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    const closed = once(child, "close");
    await once(child.stdout, "data");
    assert.ok(child.kill(signal));
    assert.deepEqual(await closed, [0, null]);
    assert.equal(output, "ready\nclosed\n");
  });
}

test("synchronous and asynchronous configuration failures keep the metric prefix and redact error details", () => {
  for (const [prefix, run] of [["worker", "() =>"], ["social.worker", "async () =>"]]) {
    const child = spawnSync(process.execPath, args(`
      await runWorkerProcess(${JSON.stringify(prefix)}, ["secret-value"], ${run} {
        throw new Error("invalid secret-value https://user:password@node synthetic-provider-message");
      });
    `), { encoding: "utf8", timeout: 5_000 });
    assert.equal(child.status, 1, child.stderr);
    const line = JSON.parse(child.stderr);
    assert.equal(line.metric, `${prefix}.config_error`);
    assert.match(line.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(line.error, "Error");
    assert.doesNotMatch(child.stderr, /secret-value|password|synthetic-provider-message/);
  }
});

test("uncaught exceptions and unhandled rejections exit with an error label only", () => {
  for (const failure of [
    'setTimeout(() => { throw new Error("secret-value"); }, 0)',
    'void Promise.reject(new Error("secret-value"))',
  ]) {
    const child = spawnSync(process.execPath, args(`
      await runWorkerProcess("worker", [], async () => {
        ${failure};
        await new Promise(() => {});
      });
    `), { encoding: "utf8", timeout: 5_000 });
    assert.equal(child.status, 1, child.stderr);
    assert.deepEqual(Object.keys(JSON.parse(child.stderr)).sort(), ["at", "error", "level", "metric"]);
    assert.equal(JSON.parse(child.stderr).level, 50);
    assert.equal(JSON.parse(child.stderr).metric, "worker.crashed");
    assert.doesNotMatch(child.stderr, /secret-value/);
  }
});

test("a fatal configuration log reaches stderr completely before the worker exits", () => {
  const child = spawnSync(process.execPath, args(`
    process.stderr.write("x".repeat(128 * 1024) + "\\n");
    await runWorkerProcess("worker", ["secret-value"], async () => {
      throw new Error("secret-value");
    });
  `), { encoding: "utf8", timeout: 5_000 });
  assert.equal(child.status, 1);
  const [buffered, fatal] = child.stderr.trimEnd().split("\n");
  assert.equal(buffered?.length, 128 * 1024);
  const entry = JSON.parse(fatal);
  assert.equal(entry.metric, "worker.config_error");
  assert.equal(entry.error, "Error");
  assert.equal(entry.level, 50);
});

test("social worker completion cannot interrupt a pending fatal log", () => {
  const script = new URL("../../scripts/worker.ts", import.meta.url).href;
  const worker = `data:text/javascript,${encodeURIComponent(`
    export const socialWorkerSecrets = () => [];
    export async function runSocialWorker() {
      process.stderr.write("x".repeat(128 * 1024) + "\\n");
      process.emit("uncaughtException", new Error("synthetic crash"));
      return "stopped";
    }
  `)}`;
  const child = spawnSync(process.execPath, args(`
    const { registerHooks } = await import("node:module");
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "#workers/modules/social/worker/main.ts") {
          return { url: ${JSON.stringify(worker)}, shortCircuit: true };
        }
        return nextResolve(specifier, context);
      }
    });
    process.argv.splice(1, Infinity, "worker.ts", "social");
    await import(${JSON.stringify(script)});
  `), { encoding: "utf8", timeout: 5_000 });

  assert.equal(child.status, 1);
  const [buffered, fatal] = child.stderr.trimEnd().split("\n");
  assert.equal(buffered?.length, 128 * 1024);
  assert.ok(fatal);
  assert.equal(JSON.parse(fatal).metric, "social.worker.crashed");
});
