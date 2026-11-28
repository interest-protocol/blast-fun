import assert from "node:assert/strict";
import { globSync } from "node:fs";
import { PRIVATE_ROUTES } from "@blast/core/modules/backend-api/private-routes.ts";
import { OPTIONS } from "#web/app/api/[...path]/route.ts";

export function apiRoutePaths(): Set<string> {
  const paths = new Set<string>();
  for (const { path, ssrOnly } of PRIVATE_ROUTES) {
    if (!ssrOnly && path.startsWith("/api/")) paths.add(path);
  }
  const cwd = new URL("../../src/app/api/", import.meta.url);
  for (const file of globSync("**/route.{ts,tsx,js}", { cwd })) {
    if (file === "[...path]/route.ts") continue;
    const path = file.replace(/\/?route\.[^.]+$/, "").replace(/\[(\w+)\]/g, ":$1");
    paths.add(path ? `/api/${path}` : "/api");
  }
  return paths;
}

export async function assertApiAllow(path: string, allow: string): Promise<void> {
  const response = await OPTIONS(new Request(`https://blast.fun${path}`, { method: "OPTIONS" }));
  assert.equal(response.status, 204, path);
  assert.equal(response.headers.get("Allow"), allow, path);
}
