import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { takeProcessSingleton } from "@blast/core/lib/process-singleton.ts";
import { endProcessPools } from "../../../../core/test/fixtures/modules/database/testing.ts";
import { RUNTIME_TEST_ENVIRONMENT } from "../../../test/fixtures/config/runtime-config.ts";
import { withLaunchpadRuntime } from "./runtime.ts";

const SHORT_PEPPER = "short-pepper-value";

/** Everything the runtime needs, valid; the pool connects only on first query. */
const BUILDABLE_ENVIRONMENT = {
  ...RUNTIME_TEST_ENVIRONMENT,
  DATABASE_URL: "postgresql://launchpad:unused@127.0.0.1:9/blast",
  PRIVY_JWT_VERIFICATION_KEY: generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    .publicKey.export({ type: "spki", format: "pem" })
    .toString(),
};

async function capture(operation: () => Promise<Response>) {
  const info: string[] = [];
  const warn: string[] = [];
  const originalInfo = console.info;
  const originalWarn = console.warn;
  console.info = (...args: unknown[]) => void info.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => void warn.push(args.map(String).join(" "));
  try {
    return { response: await operation(), info, warn };
  } finally {
    console.info = originalInfo;
    console.warn = originalWarn;
  }
}

test("a runtime that cannot be built answers 503, reports a fixed reason, and warns without secrets", async (t) => {
  await endProcessPools();
  takeProcessSingleton("runtimeConfig");
  t.after(async () => {
    await endProcessPools();
    takeProcessSingleton("runtimeConfig");
  });
  Object.assign(process.env, BUILDABLE_ENVIRONMENT, { RATE_LIMIT_SUBJECT_PEPPER: SHORT_PEPPER });
  delete process.env.MISSION_CONTROL_METRICS;
  let ran = false;

  const { response, info, warn } = await capture(() =>
    withLaunchpadRuntime(async () => {
      ran = true;
      return new Response(null, { status: 204 });
    }),
  );

  assert.equal(ran, false);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("retry-after"), "5");
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, "LAUNCHPAD_UNAVAILABLE");
  const requestId = response.headers.get("x-request-id");
  assert.ok(requestId);
  const metrics = info.map((line) => {
    const fields = JSON.parse(line) as Record<string, unknown>;
    delete fields.at;
    return fields;
  });
  assert.deepEqual(metrics, [
    { level: 30, metric: "launchpad.identity", requestId, outcome: "config_unavailable", reason: "setup_failed:Error" },
    { level: 30, metric: "http.error", route: "LAUNCHPAD_UNAVAILABLE", requestId, code: "LAUNCHPAD_UNAVAILABLE", status: 503 },
  ]);
  assert.equal(warn.length, 1);
  assert.match(warn[0]!, /"reason":"setup_failed:Error"/);
  for (const line of [...info, ...warn, JSON.stringify(body)]) {
    assert.ok(!line.includes(SHORT_PEPPER), line);
  }

  // The short pepper was the only fault: with a valid one the same route runs.
  process.env.RATE_LIMIT_SUBJECT_PEPPER = BUILDABLE_ENVIRONMENT.RATE_LIMIT_SUBJECT_PEPPER;
  const recovered = await withLaunchpadRuntime(async () => {
    ran = true;
    return new Response(null, { status: 204 });
  });
  assert.equal(recovered.status, 204);
  assert.equal(ran, true);
});
