import { socialFeedRoute } from "../modules/social/feed/runtime.ts";
import { socialProfileRoutes } from "../modules/social/profiles/runtime.ts";
import { socialPostRoutes } from "../modules/social/posts/runtime.ts";
import { socialWhyRoutes } from "../modules/social/whys/runtime.ts";
import type { PrivateHandlers } from "./handler.ts";

export const SOCIAL_READ_HANDLERS = {
  "social.feed": (request, { client }) => socialFeedRoute().GET(request, client),
  "social.feed.new": (request, { client }) => socialFeedRoute().NEW(request, client),
  "social.post": (request, { client }) => socialPostRoutes().item.GET(request, client),
  "social.reaction.put": (request, { client }) => socialPostRoutes().reaction.PUT(request, client),
  "social.reaction.delete": (request, { client }) => socialPostRoutes().reaction.DELETE(request, client),
  "social.why.create": (request, { client }) => socialWhyRoutes().create.POST(request, client),
  "social.why.delete": (request, { client }) => socialWhyRoutes().remove.DELETE(request, client),
  "social.why.report": (request, { client }) => socialWhyRoutes().report.POST(request, client),
  "social.profile": (request, { client }) => socialProfileRoutes().profile.GET(request, client),
  "social.profile.items": (request, { client }) => socialProfileRoutes().items.GET(request, client),
  "social.profile.calls": (request, { client }) => socialProfileRoutes().calls.GET(request, client),
  "social.profile.theses": (request, { client }) => socialProfileRoutes().theses.GET(request, client),
  "social.profile.connections": (request, { client }) => socialProfileRoutes().connections.GET(request, client),
  "social.profile.mutuals": (request, { client }) => socialProfileRoutes().mutuals.GET(request, client),
  "social.me.presales": (request, { client }) => socialProfileRoutes().mePresales.GET(request, client),
  "social.me.presales.created": (request, { client }) => socialProfileRoutes().createdPresales.GET(request, client),
} satisfies PrivateHandlers;
