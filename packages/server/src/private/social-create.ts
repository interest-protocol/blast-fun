import { encodeCreateContext } from "@blast/core/modules/social/create/context.ts";
import { createPageContext } from "../modules/social/create/context.ts";
import { socialCreateRoutes } from "../modules/social/create/runtime.ts";
import type { PrivateHandlers } from "./handler.ts";

export const SOCIAL_CREATE_HANDLERS = {
  "social.create.context": async () =>
    new Response(encodeCreateContext(await createPageContext()), {
      headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
    }),
  "social.create.list": (request, { client }) => socialCreateRoutes().list.GET(request, client),
  "social.create.read": (request, { client }) => socialCreateRoutes().draft.GET(request, client),
  "social.create.save": (request, { client }) => socialCreateRoutes().draft.PUT(request, client),
  "social.create.delete": (request, { client }) => socialCreateRoutes().draft.DELETE(request, client),
  "social.create.logo": (request, { client }) => socialCreateRoutes().logo.PUT(request, client),
  "social.create.cover.upload": (request, { client }) => socialCreateRoutes().cover.POST(request, client),
  "social.create.cover.delete": (request, { client }) => socialCreateRoutes().cover.DELETE(request, client),
  "social.create.published": (request, { client }) => socialCreateRoutes().published.POST(request, client),
  "social.create.publish": (request, { client }) => socialCreateRoutes().publish.POST(request, client),
} satisfies PrivateHandlers;
