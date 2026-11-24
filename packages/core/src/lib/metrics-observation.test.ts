import assert from "node:assert/strict";
import test from "node:test";

import { observeMetric } from "./metrics.ts";

test("observations sample hot successes and retain unsampled refusals with explicit denominators", (t) => {
  const lines: string[] = [];
  t.mock.method(console, "info", (line: string) => lines.push(line));
  const random = t.mock.method(Math, "random", () => 0.01);
  observeMetric("backend.admission", { lane: "ordinary", outcome: "admitted" }, { sampleRate: 0.02 });
  random.mock.mockImplementation(() => 0.5);
  observeMetric("backend.admission", { lane: "ordinary", outcome: "admitted" }, { sampleRate: 0.02 });
  observeMetric("backend.admission", { lane: "ordinary", outcome: "busy" });
  assert.equal(lines.length, 2);
  const [admitted, busy] = lines.map((line) => JSON.parse(line));
  assert.equal(admitted.sampleRate, 0.02);
  assert.equal(admitted.outcome, "admitted");
  assert.equal(busy.outcome, "busy");
  assert.equal(busy.sampleRate, undefined);
  assert.equal(random.mock.callCount(), 2, "unsampled refusals do not invoke the sampler");
});

test("disabled and browser observations call neither sampler nor sink", (t) => {
  const random = t.mock.method(Math, "random", () => { throw new Error("sampler must remain idle"); });
  const sink = t.mock.method(console, "info", () => { throw new Error("sink must remain idle"); });
  const previous = process.env.MISSION_CONTROL_METRICS;
  const scope = globalThis as { window?: unknown };
  const hadWindow = Object.hasOwn(scope, "window");
  const previousWindow = scope.window;
  try {
    process.env.MISSION_CONTROL_METRICS = "off";
    observeMetric("disabled", {}, { sampleRate: 0.02 });
    delete process.env.MISSION_CONTROL_METRICS;
    scope.window = globalThis;
    observeMetric("browser", {}, { sampleRate: 0.02 });
  } finally {
    if (previous === undefined) delete process.env.MISSION_CONTROL_METRICS;
    else process.env.MISSION_CONTROL_METRICS = previous;
    if (hadWindow) scope.window = previousWindow;
    else delete scope.window;
  }
  assert.equal(random.mock.callCount(), 0);
  assert.equal(sink.mock.callCount(), 0);
});

test("throwing samplers and sinks cannot escape observations", (t) => {
  const random = t.mock.method(Math, "random", () => { throw new Error("sampler unavailable"); });
  const sink = t.mock.method(console, "info", () => { throw new Error("log drain unavailable"); });
  assert.doesNotThrow(() => observeMetric("sampled", {}, { sampleRate: 0.02 }));
  assert.doesNotThrow(() => observeMetric("unsampled"));
  assert.equal(random.mock.callCount(), 1);
  assert.equal(sink.mock.callCount(), 1);
});
