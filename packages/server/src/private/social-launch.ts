import { myBondingLaunchesRoute } from "../modules/social/launch/discovery-runtime.ts";
import {
  launchPageContext,
  socialLaunchRoutes,
} from "../modules/social/launch/runtime.ts";
import type { PrivateHandlers } from "./handler.ts";

export const SOCIAL_LAUNCH_HANDLERS = {
  "social.launch.context": async () =>
    new Response(JSON.stringify(await launchPageContext()), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "private, no-store",
      },
    }),
  "social.launch.discovery": (request, { client }) => myBondingLaunchesRoute()(request, client),
  "social.launch.list": (request, { client }) => socialLaunchRoutes().list.GET(request, client),
  "social.launch.read": (request, { client }) => socialLaunchRoutes().draft.GET(request, client),
  "social.launch.save": (request, { client }) => socialLaunchRoutes().draft.PUT(request, client),
  "social.launch.delete": (request, { client }) => socialLaunchRoutes().draft.DELETE(request, client),
  "social.launch.logo": (request, { client }) => socialLaunchRoutes().logo.PUT(request, client),
  "social.launch.cover.upload": (request, { client }) => socialLaunchRoutes().cover.POST(request, client),
  "social.launch.cover.delete": (request, { client }) => socialLaunchRoutes().cover.DELETE(request, client),
  "social.launch.published": (request, { client }) => socialLaunchRoutes().published.POST(request, client),
  "social.launch.publish": (request, { client }) => socialLaunchRoutes().publish.POST(request, client),
} satisfies PrivateHandlers;
