import assert from "node:assert/strict";
import test from "node:test";
import { frontendClientAddress, frontendIngress } from "./frontend-ingress.ts";

test("frontend proof address comes from a single asserted platform header, never caller fallbacks", () => {
  const request = (
    headers: Record<string, string>,
    origin = "https://frontend.test",
  ) => new Request(origin, { headers });
  const spoof = { "x-forwarded-for": "192.0.2.9", "x-real-ip": "192.0.2.8" };
  const vercel = frontendIngress({ VERCEL: "1", NODE_ENV: "production" });
  assert.equal(frontendClientAddress(request(spoof), vercel), null);
  assert.equal(
    frontendClientAddress(request({ ...spoof, "x-vercel-forwarded-for": "192.0.2.1" }), vercel),
    "192.0.2.1",
  );
  for (const invalid of ["192.0.2.1,192.0.2.2", "garbage", "", "192.0.2.1:80"])
    assert.equal(
      frontendClientAddress(request({ ...spoof, "x-vercel-forwarded-for": invalid }), vercel),
      null,
    );
  assert.equal(
    frontendClientAddress(request({ "x-vercel-forwarded-for": "192.0.2.1" }), frontendIngress({})),
    null,
  );
  assert.equal(
    frontendClientAddress(request(spoof, "http://127.0.0.1"), frontendIngress({ NODE_ENV: "test" })),
    "127.0.0.1",
  );
  assert.equal(
    frontendClientAddress(request(spoof, "http://127.0.0.1"), frontendIngress({ NODE_ENV: "production" })),
    null,
  );
});
