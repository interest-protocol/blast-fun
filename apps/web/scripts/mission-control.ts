import {
  createPool,
  migrateDatabase,
  migrationDatabaseUrl,
  resetDatabase,
} from "@blast/core/modules/database/admin.ts";

const command = process.argv[2];
// Schema changes and resets run on the primary's direct endpoint as the
// migration login; the rest runs as the app does.
const pool = createPool(
  command === "migrate" || command === "reset"
    ? migrationDatabaseUrl()
    : undefined,
);

try {
  switch (command) {
    case "migrate": {
      const applied = await migrateDatabase(pool);
      console.log(
        applied.length === 0
          ? "Mission Control database is already current."
          : `Applied migrations: ${applied.join(", ")}`,
      );
      break;
    }
    case "reset": {
      const preserved = await resetDatabase(pool);
      console.log(
        `Reset Mission Control runtime data; preserved migrations: ${preserved.join(", ")}`,
      );
      break;
    }
    case "cleanup": {
      const { runCleanup } = await import("@blast/server/modules/mission-control/maintenance/service.ts");
      const report = await runCleanup(pool);
      console.log(JSON.stringify(report, null, 2));
      if (!report.ok) process.exitCode = 1;
      break;
    }
    default:
      throw new Error(
        "Usage: mission-control.ts <migrate|reset|cleanup>",
      );
  }
} finally {
  await pool.end();
}
