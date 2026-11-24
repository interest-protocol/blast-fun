import assert from "node:assert/strict";
import test from "node:test";

import { NOTIFICATION_PREFERENCE_KEYS } from "@blast/core/modules/social/contracts/settings.ts";
import { socialSettingsRequestSchema } from "@blast/core/modules/social/contracts/settings.ts";

test("notification changes accept supported switches and reject every unknown JSON key", () => {
  for (const key of NOTIFICATION_PREFERENCE_KEYS) {
    for (const value of [true, false]) {
      assert.deepEqual(socialSettingsRequestSchema.parse({ notifications: { [key]: value } }), {
        notifications: { [key]: value },
      });
    }
  }
  for (const key of ["extra", "__proto__", "constructor"]) {
    const value = { notifications: { [key]: true } };
    assert.equal(socialSettingsRequestSchema.safeParse(value).success, false, key);
  }
  assert.equal(socialSettingsRequestSchema.safeParse({ notifications: { [NOTIFICATION_PREFERENCE_KEYS[0]]: "true" } }).success, false);
});
