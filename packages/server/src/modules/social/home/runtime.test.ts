import assert from "node:assert/strict";
import { takeProcessSingleton } from "@blast/core/lib/process-singleton.ts";
import { registerHooks } from "node:module";
import test from "node:test";

import { installRuntimeConfig } from "../../../../test/fixtures/config/runtime-config.ts";

installRuntimeConfig();

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only")
      return { url: "data:text/javascript,export {}", shortCircuit: true };
    return next(specifier, context);
  },
});

test("Home handlers are one instance per process", async (t) => {
  const slot = Symbol.for("blast.social.home-routes");
  const previous = Reflect.get(globalThis, slot);
  t.after(() => {
    if (previous === undefined) Reflect.deleteProperty(globalThis, slot);
    else Reflect.set(globalThis, slot, previous);
  });
  Reflect.deleteProperty(globalThis, slot);
  const { socialHomeRoutes } = await import("@blast/server/modules/social/home/runtime.ts");
  assert.equal(socialHomeRoutes(), socialHomeRoutes());
});

// Exercise the same source injected into Home, including its keyed HTTP reader.
test("Home terms failures return unavailable and observe safe labels for network, status and malformed bodies", async (t) => {
  const { readHomeTerms } = await import("./runtime.ts");
  installRuntimeConfig();
  takeProcessSingleton("social.home-terms");
  t.after(() => {
    takeProcessSingleton("social.home-terms");
    takeProcessSingleton("runtimeConfig");
  });
  const previous = process.env.MISSION_CONTROL_METRICS;
  process.env.MISSION_CONTROL_METRICS = "on";
  t.after(() => {
    if (previous === undefined) delete process.env.MISSION_CONTROL_METRICS;
    else process.env.MISSION_CONTROL_METRICS = previous;
  });
  const records: Record<string, unknown>[] = [];
  t.mock.method(console, "info", (line: string) => {
    records.push(JSON.parse(line));
  });
  let reply: () => Response = () => {
    throw new Error("private network endpoint");
  };
  t.mock.method(globalThis, "fetch", async () => reply());
  assert.equal(await readHomeTerms(`0x${"79".repeat(32)}`), null);
  reply = () => Response.json({ private: "private provider payload" }, { status: 503 });
  assert.equal(await readHomeTerms(`0x${"7a".repeat(32)}`), null);
  reply = () => new Response("private malformed body", { status: 200 });
  assert.equal(await readHomeTerms(`0x${"7b".repeat(32)}`), null);
  assert.deepEqual(
    records
      .filter((record) => record.metric === "social.source")
      .map(({ source, outcome, error }) => ({ source, outcome, error })),
    [
      { source: "home_presale_terms", outcome: "unavailable", error: "TermsUnavailable" },
      { source: "home_presale_terms", outcome: "unavailable", error: "TermsUnavailable" },
      { source: "home_presale_terms", outcome: "unavailable", error: "TermsUnavailable" },
    ],
  );
  assert.equal(JSON.stringify(records).includes("private"), false);
});
