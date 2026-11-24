import { socialProfileEditRoutes } from "../modules/social/profile-edit/runtime.ts";
import type { PrivateHandlers } from "./handler.ts";

export const SOCIAL_PROFILE_EDIT_HANDLERS = {
  "social.me.profile.read": (request, { client }) => socialProfileEditRoutes().profile.GET(request, client),
  "social.me.profile.write": (request, { client }) => socialProfileEditRoutes().profile.PUT(request, client),
  "social.me.profile.picture": (request, { client }) => socialProfileEditRoutes().picture.PUT(request, client),
} satisfies PrivateHandlers;
