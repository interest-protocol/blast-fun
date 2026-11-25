import { serviceHealthRoute } from "../modules/service-health/route.ts";
import { competitionRankRoute, competitionRoutes } from "../modules/social/competitions/runtime.ts";
import { socialWorkspaceRoute } from "../modules/social/workspace/runtime.ts";
import { socialHomeRoutes } from "../modules/social/home/runtime.ts";
import { socialBuyAlertRoutes } from "../modules/social/buy-alerts/runtime.ts";
import { socialFollowRoutes } from "../modules/social/follows/runtime.ts";
import { socialWatchlistRoutes } from "../modules/social/watchlist/runtime.ts";
import { socialNotificationRoutes } from "../modules/social/notifications/runtime.ts";
import { socialOnboardingRoutes } from "../modules/social/onboarding/runtime.ts";
import { socialViewerStateRoute } from "../modules/social/viewer-state/runtime.ts";
import type { PrivateHandlers } from "./handler.ts";

/** Lazy factories retain original primary transaction, caller and quota owners. */
export const SOCIAL_HANDLERS = {
  "social.health": () => serviceHealthRoute(),
  "social.competitions": (request, { client }) => competitionRoutes()(request, client),
  "social.competitions.rank": (request, { client }) => competitionRankRoute()(request, client),
  "social.home.activity-stream": (request, { client }) => socialHomeRoutes().ACTIVITY_STREAM(request, client),
  "social.workspace.read": (request, { client }) => socialWorkspaceRoute().GET(request, client),
  "social.workspace.write": (request, { client }) => socialWorkspaceRoute().PUT(request, client),
  "social.following.wallets": (request, { client }) => socialBuyAlertRoutes().wallets.GET(request, client),
  "social.follow.account.put": (request, { client }) => socialFollowRoutes().account.PUT(request, client),
  "social.follow.account.delete": (request, { client }) => socialFollowRoutes().account.DELETE(request, client),
  "social.follow.presale.put": (request, { client }) => socialFollowRoutes().presale.PUT(request, client),
  "social.follow.presale.delete": (request, { client }) => socialFollowRoutes().presale.DELETE(request, client),
  "social.watchlist.list": (request, { client }) => socialWatchlistRoutes().list.GET(request, client),
  "social.watchlist.ids": (request, { client }) => socialWatchlistRoutes().ids.GET(request, client),
  "social.watchlist.keys": (request, { client }) => socialWatchlistRoutes().keys.GET(request, client),
  "social.watchlist.put": (request, { client }) => socialWatchlistRoutes().item.PUT(request, client),
  "social.watchlist.delete": (request, { client }) => socialWatchlistRoutes().item.DELETE(request, client),
  "social.notifications.page": (request, { client }) => socialNotificationRoutes().page.GET(request, client),
  "social.notifications.unread": (request, { client }) => socialNotificationRoutes().unread.GET(request, client),
  "social.notifications.read": (request, { client }) => socialNotificationRoutes().markRead.POST(request, client),
  "social.notifications.read-all": (request, { client }) => socialNotificationRoutes().readAll.POST(request, client),
  "social.onboarding.shown": (request, { client }) => socialOnboardingRoutes().shown.POST(request, client),
  "social.onboarding.complete": (request, { client }) => socialOnboardingRoutes().complete.POST(request, client),
  "social.viewer-state": (request, { client }) => socialViewerStateRoute().POST(request, client),
} satisfies PrivateHandlers;
