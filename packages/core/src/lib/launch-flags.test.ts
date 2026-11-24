import assert from "node:assert/strict";
import test from "node:test";

import { isLaunchEnabled, LAUNCH_FLAG_VARIABLES, LAUNCH_SURFACES, launchFlagsFor } from "./launch-flags.ts";

test("launch surfaces accept true and the deployed team alias, and default off", () => {
  for (const surface of LAUNCH_SURFACES) {
    const variable = LAUNCH_FLAG_VARIABLES[surface];
    for (const value of [undefined, "", "false", "TRUE", "true ", "1", "true", "team"]) {
      const environment = { [variable]: value };
      const enabled = value === "true" || value === "team";
      assert.equal(isLaunchEnabled(surface, environment), enabled, `${variable}=${value}`);
      assert.equal(launchFlagsFor(environment)[surface], enabled, `${variable}=${value}`);
      assert.equal(Object.values(launchFlagsFor(environment)).filter(Boolean).length, enabled ? 1 : 0);
    }
  }
});
