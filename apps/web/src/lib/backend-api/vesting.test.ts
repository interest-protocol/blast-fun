import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { VestingReadError } from "@blast/core/modules/vesting/errors.ts";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only")
      return { url: "data:text/javascript,export {}", shortCircuit: true };
    return next(specifier, context);
  },
});
const { vestingBackendPageRead } = await import("./vesting.ts");

test("vesting SSR keeps the public error distinction and uses only the backend HTTP read", async () => {
  let status = 200;
  const seen: Request[] = [];
  const read = vestingBackendPageRead({
    origin: "https://frontend.test",
    headers: async () => new Headers({ cookie: "synthetic-retained-cookie" }),
    relay: async (request) => {
      seen.push(request);
      return Response.json(
        { now_ms: 123, schedule: { indexed: true }, events: [] },
        { status },
      );
    },
  });
  assert.equal((await read("0x123")).schedule.indexed, true);
  assert.equal(seen[0]!.url, "https://frontend.test/api/vesting/0x123");
  for (const [code, reason] of [
    [404, "not_found"],
    [422, "unsupported"],
    [503, "unavailable"],
  ] as const) {
    status = code;
    await assert.rejects(
      read("0x123"),
      (error) => error instanceof VestingReadError && error.reason === reason,
    );
  }
});
