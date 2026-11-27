import { launchpadCsrfResponse } from "../modules/launchpad-identity/csrf.ts";
import type { PrivateHandlers } from "./handler.ts";

export const NON_SOCIAL_HANDLERS = {
  "launchpad.csrf": launchpadCsrfResponse,
} satisfies PrivateHandlers;
