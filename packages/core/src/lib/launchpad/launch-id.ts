import { z } from "zod";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

// A launch ID is the Sui object ID of a launch (the SDK's `launch_id: ID`).
// This parser accepts only its canonical, normalized form.
export const launchIdSchema = z.string().regex(SUI_OBJECT_ID_PATTERN);

/** The launch ID when `value` is already canonical; otherwise null. Never normalizes. */
export function parseLaunchId(value: string): string | null {
  const parsed = launchIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
