import type { PrivateRouteContract } from "../private-routes.ts";
import { WORKSPACE_MAX_BYTES } from "../../social/blast-workspace/codec.ts";

const READS: readonly PrivateRouteContract[] = [
  { id: "social.health", method: "GET", path: "/api/social/health", maxBodyBytes: 0 },
  { id: "social.competitions", method: "GET", path: "/api/social/competitions", maxBodyBytes: 0, ssrRead: true },
  { id: "social.competitions.rank", method: "GET", path: "/api/social/me/competitions/rank", maxBodyBytes: 0 },
  { id: "social.home.activity-stream", method: "GET", path: "/api/social/home/activity-stream", maxBodyBytes: 0, ssrRead: true },
  { id: "social.workspace.read", method: "GET", path: "/api/social/me/blast-workspace", maxBodyBytes: 0 },
];

/** New develop endpoints retain their original owners behind the private gateway. */
export const DEVELOP_PRIVATE_ROUTES: readonly PrivateRouteContract[] = Object.freeze([
  ...READS,
  ...READS.map((route) => ({ ...route, method: "HEAD" })),
  { id: "social.workspace.write", method: "PUT", path: "/api/social/me/blast-workspace", maxBodyBytes: WORKSPACE_MAX_BYTES, resourceClass: "upload" },
]);
