import { socialCommitRoutes } from "../modules/social/commit/runtime.ts";
import type { PrivateHandlers } from "./handler.ts";

export const COMMIT_HANDLERS = {
  "social.commit.build": (request, { client }) => socialCommitRoutes().build(request, client),
} satisfies PrivateHandlers;
