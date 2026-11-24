import assert from "node:assert/strict";
import test from "node:test";

import { createTestQueryClient, settleQueries } from "./test-client.ts";

test("query settling times out even when a fixture freezes the wall clock", async (t) => {
  t.mock.method(Date, "now", () => 0);
  const client = createTestQueryClient();
  const response = Promise.withResolvers<string>();
  const read = client.fetchQuery({ queryKey: ["pending-fixture"], queryFn: () => response.promise });
  try {
    await assert.rejects(settleQueries(client, 10), /Queries did not settle/);
  } finally {
    response.resolve("done");
    await read;
    client.clear();
  }
});
