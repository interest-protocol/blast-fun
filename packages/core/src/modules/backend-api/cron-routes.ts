/** Cron credentials grant only these maintenance operations, never browser/private capabilities. */
export const CRON_ROUTES = Object.freeze([
  "/api/mission-control/maintenance/cleanup",
] as const);

export type CronRoutePath = (typeof CRON_ROUTES)[number];

export type CronRouteContract = Readonly<{
  path: CronRoutePath;
  method: "GET" | "HEAD";
  maxBodyBytes: 0;
  workBudgetMs: 60_000;
}>;

export function cronRoute(
  method: string,
  path: string,
): CronRouteContract | null {
  if (method !== "GET" && method !== "HEAD") return null;
  for (const allowed of CRON_ROUTES) {
    if (path === allowed)
      return { path: allowed, method, maxBodyBytes: 0, workBudgetMs: 60_000 };
  }
  return null;
}
