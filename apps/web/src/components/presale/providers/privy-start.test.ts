import assert from "node:assert/strict";
import test from "node:test";
import type { PrivyRuntime } from "#web/components/auth/privy-session.ts";
import { PrivyStart } from "./privy-start.ts";

const runtime = { authenticated: true } as PrivyRuntime;

test("a failed start ignores its unmounting SDK's late ready; the retry's ready counts", async () => {
  const start = new PrivyStart();
  start.fail();
  start.publish(runtime);
  assert.equal(start.state().runtime, null);

  const waiting = start.wait(() => undefined);
  start.publish(runtime);
  assert.equal(await waiting, runtime);
});

test("after the provider stops, a new wait rejects at once", async () => {
  const start = new PrivyStart();
  start.stop();
  await assert.rejects(start.wait(() => undefined), /Privy stopped/);
});

test("a Strict Mode remount reopens a stopped start", async () => {
  const start = new PrivyStart();
  start.mount()();
  start.mount();
  const waiting = start.wait(() => undefined);
  start.publish(runtime);
  assert.equal(await waiting, runtime);
});
