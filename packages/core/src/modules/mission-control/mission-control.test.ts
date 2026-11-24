import assert from "node:assert/strict";
import test from "node:test";

import { MISSION_CONTROL_MODULES, TABLE_OWNERSHIP, assertTableOwnership } from "@blast/core/modules/database/modules.ts";
import { assertOwnedWriteStatement, assertReadOnlyStatement, type ModuleTransaction } from "@blast/core/modules/database/transaction.ts";

test("all Mission Control modules publish an explicit table boundary", () => {
  assert.deepEqual(Object.keys(TABLE_OWNERSHIP), [...MISSION_CONTROL_MODULES]);
  assert.doesNotThrow(() =>
    assertTableOwnership("campaign-event", "mission_control_campaign_events"),
  );
  assert.throws(
    () =>
      assertTableOwnership("profile", "mission_control_campaign_events"),
    /cannot write table/,
  );
  assert.doesNotThrow(() =>
    assertOwnedWriteStatement(
      "profile",
      "mission_control_profiles",
      "INSERT INTO mission_control_profiles (profile_id) VALUES ($1)",
    ),
  );
  assert.throws(
    () =>
      assertOwnedWriteStatement(
        "profile",
        "mission_control_profiles",
        "DELETE FROM mission_control_campaign_events",
      ),
    /declared.*but targets/,
  );
  assert.throws(
    () => assertReadOnlyStatement("SELECT 1; DELETE FROM mission_control_campaign_events"),
    /one statement only/,
  );
  assert.throws(
    () =>
      assertReadOnlyStatement(
        "SELECT 1 AS revision INTO mission_control_profiles",
      ),
    /rejects SELECT INTO/,
  );
});

function compileTimeOwnershipContract(
  profile: ModuleTransaction<"profile">,
): void {
  void profile.write("mission_control_profiles", "SELECT 1");
  // @ts-expect-error A profile repository cannot write the event table.
  void profile.write("mission_control_campaign_events", "SELECT 1");
}
void compileTimeOwnershipContract;
