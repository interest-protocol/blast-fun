import assert from "node:assert/strict";
import test from "node:test";
import { UNAVAILABLE_RETRY_AFTER_SECONDS } from "@blast/core/modules/database/availability.ts";

import { accountWalletRoute } from "@blast/server/modules/mission-control/account-links/runtime.ts";
import { endProcessPools } from "../../../../../core/test/fixtures/modules/database/testing.ts";
import { installRuntimeConfig } from "../../../../test/fixtures/config/runtime-config.ts";
import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";

test("a route whose dependency throws records the cause and keeps its 503", async (t) => {
  await endProcessPools();
  installRuntimeConfig({ DATABASE_URL: undefined });
  const lines: Record<string, unknown>[] = [];
  t.mock.method(console, "info", (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>));

  const response = await accountWalletRoute(
    new Request("https://blast.test/api/mission-control/owner/wallets/challenge", { method: "POST" }),
    testClient("203.0.113.9"),
    "issue",
  );

  const requestId = response.headers.get("x-request-id");
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), String(UNAVAILABLE_RETRY_AFTER_SECONDS));
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(
    await response.text(),
    '{"error":{"code":"ACCOUNT_LINK_UNAVAILABLE","message":"Account linking is temporarily unavailable."}}',
  );
  const errors = lines.filter((line) => line.metric === "http.error");
  assert.deepEqual(errors.map(({ route, requestId: id, code, status, cause }) => ({ route, requestId: id, code, status, cause })), [
    { route: "ACCOUNT_LINK_UNAVAILABLE", requestId, code: "ACCOUNT_LINK_UNAVAILABLE", status: 503, cause: "Error" },
  ]);
  assert.doesNotMatch(JSON.stringify(lines), /DATABASE_URL/);
});
