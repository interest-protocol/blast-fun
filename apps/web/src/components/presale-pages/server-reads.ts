import "server-only";
import { connection } from "next/server";
import { cache } from "react";
import { readPresaleFromBackend } from "#web/lib/backend-api/presales.ts";

type SaleRead =
  Readonly<{ status: "ok"; detail: NonNullable<Awaited<ReturnType<typeof readPresaleFromBackend>>>; nowMs: number }> | Readonly<{ status: "missing" | "error" }>;

/** One sale read per request, shared by the metadata, the page and its right column. */
export const saleOf = cache(async (presaleId: string): Promise<SaleRead> => {
  await connection();
  const nowMs = Date.now();
  try {
    const detail = await readPresaleFromBackend(presaleId);
    return detail ? { status: "ok", detail, nowMs } : { status: "missing" };
  } catch {
    return { status: "error" };
  }
});
