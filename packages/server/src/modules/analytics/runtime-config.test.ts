import assert from "node:assert/strict";
import test from "node:test";
import { parseRuntimeConfig } from "../../config/runtime-config.ts";
import { RUNTIME_TEST_ENVIRONMENT } from "../../../test/fixtures/config/runtime-config.ts";
import { createAccountActivityService } from "./activity.ts";

test("boot keeps account activity disabled and isolates malformed enabled settings", async () => {
  const disabled = parseRuntimeConfig({
    ...RUNTIME_TEST_ENVIRONMENT,
    ANALYTICS_IDENTITY_DATABASE_URL: "malformed",
    ANALYTICS_ACCOUNT_HASH_KEY: "short",
  });
  assert.equal(disabled.accountActivity, null);
  const enabled = parseRuntimeConfig({
    ...RUNTIME_TEST_ENVIRONMENT,
    ANALYTICS_ACCOUNT_ACTIVITY_ENABLED: "true",
    ANALYTICS_IDENTITY_DATABASE_URL: "malformed",
    ANALYTICS_ACCOUNT_HASH_KEY: "short",
  });
  assert.equal(enabled.siteOrigin, disabled.siteOrigin);
  assert.equal(enabled.accountActivity, "unavailable");
  const service = createAccountActivityService(enabled.accountActivity);
  try {
    const result = await service.handle(
      new Request(`${enabled.siteOrigin}/api/analytics/activity`, { method: "POST" }),
    );
    assert.equal(result.status, 503);
    assert.equal(result.headers.get("retry-after"), "30");
    assert.equal(await result.text(), "");
  } finally {
    await service.close();
  }
});
