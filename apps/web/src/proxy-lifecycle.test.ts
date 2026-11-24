import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

const webRoot = new URL("../", import.meta.url);
const hooks = new URL("../../scripts/test-tsx-hooks.mjs", webRoot);
const proxyModule = new URL("src/proxy.ts", webRoot);

test("Thin frontend proxy starts no Redis work or background warming", async () => {
  const child = `
    import assert from "node:assert/strict";
    import { registerHooks } from "node:module";
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === "server-only") return { url: "data:text/javascript,export {}", shortCircuit: true };
      return next(specifier, context);
    }});
    let calls = 0;
    globalThis[Symbol.for("blast.redis.quota")] = { warm() { calls++; throw new Error("Frontend must not start Redis warming"); } };
    const { proxy } = await import(${JSON.stringify(proxyModule.href)});
    const { NextRequest } = await import("next/server");
    assert.equal(calls, 0, "Module loading must not start untracked background work");
    const retained = [];
    const event = { waitUntil: (promise) => retained.push(promise) };
    for (let index = 0; index < 2; index++) {
      const response = await proxy(new NextRequest("https://www.blast.fun/privacy"), event);
      assert.equal(response.status, 200, "Public response must not await warming");
    }
    assert.equal(calls, 0, "The frontend never starts Redis work");
    assert.equal(retained.length, 0, "The frontend schedules no background work");
  `;
  const { stderr } = await promisify(execFile)(process.execPath,
    ["--no-warnings", "--import", hooks.href, "--experimental-strip-types", "--input-type=module", "--eval", child],
    { cwd: webRoot, env: { PATH: process.env.PATH, NODE_ENV: "test", MISSION_CONTROL_METRICS: "off",
      BLAST_QUOTA_REDIS_URL: "redis://127.0.0.1:6379" }, timeout: 15_000 });
  assert.equal(stderr, "");
});
