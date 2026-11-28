import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { installRuntimeConfig } from "../../../test/fixtures/config/runtime-config.ts";

// These fixtures use Node's scoped module hooks; retain their assertions in the Bun sweep.
if (process.versions.bun) {
  test("Node module-hook fixture", () => {
    execFileSync(
      "node",
      [
        "--no-warnings",
        "--import",
        new URL(
          "../../../../../scripts/register-runtime-types.mjs",
          import.meta.url,
        ).href,
        "--experimental-strip-types",
        "--test",
        "--test-concurrency=1",
        fileURLToPath(import.meta.url),
      ],
      { stdio: "inherit" },
    );
  });
} else {
  const { registerHooks } = await import("node:module");
  // Next's server-only marker has no Node entry.
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "server-only")
        return { url: "data:text/javascript,export {}", shortCircuit: true };
      return next(specifier, context);
    },
  });

  const { GET, healthCacheControl } = await import("./route.ts");

  test("the CDN keeps a health answer only for what is left of its 5 s", () => {
    assert.equal(healthCacheControl(10_000, 10_000), "public, max-age=0, s-maxage=5");
    assert.equal(healthCacheControl(10_000, 11_200), "public, max-age=0, s-maxage=3");
    assert.equal(healthCacheControl(10_000, 14_500), "no-store");
    assert.equal(healthCacheControl(10_000, 30_000), "no-store");
    // A clock that reads the check as later than now still never shares past 5 s.
    assert.equal(healthCacheControl(12_000, 10_000), "public, max-age=0, s-maxage=5");
  });

  test("health route authenticates only backend probes, coalesces reads, and returns safe facts the CDN may share briefly", async (t) => {
    const origin = "https://health-fixture.blast.test";
    const key = "health-fixture-key-01234567890123456789";
    installRuntimeConfig({ BLAST_INFRA_ORIGIN: origin, BLAST_INFRA_API_KEY: key });
    let backendReads = 0;
    t.mock.method(
      globalThis,
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        if (url.origin === origin) {
          backendReads += 1;
          assert.equal(url.pathname, "/v1/health");
          assert.equal(
            new Headers(init?.headers).get("x-blast-infra-key"),
            key,
          );
          assert.equal(init?.cache, "no-store");
          assert.equal(init?.redirect, "error");
          assert.ok(init?.signal);
          return Response.json({
            status: "ok",
            detail: { secret: "private-diagnostics" },
          });
        }
        assert.equal(new Headers(init?.headers).get("x-blast-infra-key"), null);
        return new Response("Sui fixture unavailable", { status: 503 });
      },
    );
    const [first, second] = await Promise.all([GET(), GET()]);
    assert.equal(first.status, 200);
    assert.match(first.headers.get("cache-control") ?? "", /^public, max-age=0, s-maxage=[1-5]$/);
    const body = await first.json();
    assert.deepEqual(await second.json(), body);
    assert.equal(backendReads, 1);
    assert.equal(body.backend, "healthy");
    assert.equal(body.sui.status, "unavailable");
    assert.doesNotMatch(
      JSON.stringify(body),
      /private-diagnostics|health-fixture|x-blast-infra-key/,
    );
  });
}
