// Run locally with the warehouse owner login. Never give this URL to the dashboard.
import { analyticsPool, requireValue } from "../src/modules/analytics/config.ts";
import { mintAccessCode } from "../src/modules/analytics/access-codes.ts";

try {
  const pool = analyticsPool(requireValue(process.env, "ANALYTICS_ACCESS_ADMIN_DATABASE_URL"), "analytics-access-admin");
  try {
    const code = await mintAccessCode(pool);
    console.log("One-time analytics password (expires in one hour; share privately):");
    console.log(code);
  } finally {
    await pool.end();
  }
} catch {
  console.error("Could not create analytics access code");
  process.exitCode = 1;
}
