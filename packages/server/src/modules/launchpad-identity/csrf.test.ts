import assert from "node:assert/strict";
import test from "node:test";
import { launchpadCsrfResponse } from "./csrf.ts";

test("anonymous CSRF bootstrap mints the original secure cookie and preserves a valid cookie", async () => {
  for (const cookie of [undefined, "__Host-blast_csrf=invalid"]) {
    const response = await launchpadCsrfResponse(
      new Request("https://blast.fun/api/launchpad/csrf", {
        headers: cookie ? { cookie } : {},
      }),
    );
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(
      response.headers.get("set-cookie") ?? "",
      /^__Host-blast_csrf=[A-Za-z0-9_-]{43}; Path=\/; Secure; SameSite=Strict$/,
    );
    assert.equal(await response.text(), "");
  }
  const kept = await launchpadCsrfResponse(
    new Request("https://blast.fun/api/launchpad/csrf", {
      headers: { cookie: `unrelated=1; __Host-blast_csrf=${"c".repeat(43)}` },
    }),
  );
  assert.equal(kept.status, 204);
  assert.equal(kept.headers.get("set-cookie"), null);
});
