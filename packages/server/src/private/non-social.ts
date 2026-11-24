import { crewRestoreRoute } from "../modules/mission-control/crew-access/runtime.ts";
import { accountWalletRoute } from "../modules/mission-control/account-links/runtime.ts";
import { launchpadCsrfResponse } from "../modules/launchpad-identity/csrf.ts";
import { ownerProfileRoute } from "../modules/mission-control/owner-profile/runtime.ts";
import { memberLogoutRoute } from "../modules/mission-control/member-sessions/runtime.ts";
import type { PrivateHandlers } from "./handler.ts";

/** Transport proof adds no member authority; each original owner still authenticates. */
export const NON_SOCIAL_HANDLERS = {
  "mission-control.owner.card": (request, { client }) => ownerProfileRoute(request, client, "card"),
  "mission-control.owner": (request, { client }) => ownerProfileRoute(request, client, "owner"),
  "mission-control.owner.recruits": (request, { client }) =>
    ownerProfileRoute(request, client, "recruits"),
  "mission-control.owner.display-name": (request, { client }) =>
    ownerProfileRoute(request, client, "displayName"),
  "mission-control.logout": (request, { client }) => memberLogoutRoute(request, client),
  "mission-control.owner.wallets": (request, { client }) =>
    accountWalletRoute(request, client, "list"),
  "mission-control.owner.wallets.primary": (request, { client }) =>
    accountWalletRoute(request, client, "primary"),
  "launchpad.csrf": launchpadCsrfResponse,
  "mission-control.owner.wallets.challenge": (request, { client }) =>
    accountWalletRoute(request, client, "issue"),
  "mission-control.owner.wallets.link": (request, { client }) =>
    accountWalletRoute(request, client, "link"),
  "mission-control.restore.challenge": (request, { client }) =>
    crewRestoreRoute(request, client, "issue"),
  "mission-control.restore.verify": (request, { client }) =>
    crewRestoreRoute(request, client, "verify"),
} satisfies PrivateHandlers;
