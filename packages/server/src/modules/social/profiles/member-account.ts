import { primaryPool } from "@blast/core/modules/database/pool.ts";
import { autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";

/** Standalone viewer reads on the primary. */
export function socialProfileViewerDatabase(): ReadableDatabase {
  return autocommitReader(primaryPool(), "social", { label: "social.profile_viewer" });
}
