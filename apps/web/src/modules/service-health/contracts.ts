import { z } from "zod";

export const HEALTH_POLL_MS = 15_000;
export const HEALTH_STALE_MS = 45_000;

export const serviceHealthSchema = z.object({
  checkedAt: z.number().int().nonnegative(),
  backend: z.enum(["healthy", "degraded", "unavailable"]),
  sui: z.object({
    status: z.enum(["healthy", "stale", "unavailable"]),
    checkpoint: z.string().regex(/^\d+$/).nullable(),
    timestampMs: z.number().int().nonnegative().nullable(),
  }),
});

export type ServiceHealth = z.infer<typeof serviceHealthSchema>;
