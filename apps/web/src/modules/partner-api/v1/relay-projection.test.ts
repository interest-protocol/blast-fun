import assert from "node:assert/strict";
import test from "node:test";

import { createBackendRelay } from "./relay.ts";

const summary = { presale_id: "0x1", name: "Orbit", backers_sample: [{ callsign: "maya" }] };

/** A relay over a stub backend that answers every read with one presale page. */
function relay(firstParty: boolean) {
  const seen: string[] = [];
  const read = createBackendRelay("https://backend.test", "test-only-gateway-secret-01234567890123456789", {
    namespace: "a".repeat(64),
    firstParty,
    clientAddress: () => "198.51.100.10",
    fetch: async (input, init) => {
      seen.push(`${init?.method} ${new URL(String(input)).pathname}`);
      return init?.method === "HEAD"
        ? new Response(null, { status: 200, headers: { "content-type": "application/json" } })
        : Response.json({ presales: [summary], next_cursor: null });
    },
  });
  return { read, seen };
}

test("blast-v2#566: partners get the published v1 summaries whatever the backend answers", async () => {
  const { read, seen } = relay(false);
  const answer = await read(new Request("https://blast.test/api/v1/presales", { headers: { "x-blast-partner-key": "k" } }));
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { presales: [{ presale_id: "0x1", name: "Orbit" }], next_cursor: null });
  const head = await read(new Request("https://blast.test/api/v1/presales", { method: "HEAD", headers: { "x-blast-partner-key": "k" } }));
  assert.equal(head.status, 200, "a HEAD has no body to project");
  assert.deepEqual(seen, ["GET /api/v1/presales", "HEAD /api/v1/presales"]);
});

test("the web's own presale reads keep every field, the facepile included", async () => {
  const { read, seen } = relay(true);
  const answer = await read(new Request("https://blast.test/api/social/presales"));
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { presales: [summary], next_cursor: null });
  assert.deepEqual(seen, ["GET /internal/public-read/api/v1/presales"]);
});
