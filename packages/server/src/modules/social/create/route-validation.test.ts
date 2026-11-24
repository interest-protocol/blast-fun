import assert from "node:assert/strict";
import test from "node:test";

import type { SocialRequestContext, SocialRouteHandler, SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { SOCIAL_CREATE_DRAFT_SAVE_ROUTE } from "@blast/core/modules/social/contracts/create.ts";
import { blankDraft } from "@blast/core/modules/social/create/model.ts";
import { createSocialCreateRoutes, type SocialCreateRoutesDependencies } from "@blast/server/modules/social/create/route.ts";

test("draft saves reject every unknown JSON key before accessing account storage", async () => {
  let save: SocialRouteHandler | undefined;
  const kit: Pick<SocialRouteKit, "route"> = {
    route(spec, handler) {
      if (spec.name === SOCIAL_CREATE_DRAFT_SAVE_ROUTE) save = handler;
      return async () => new Response();
    },
  };
  createSocialCreateRoutes({ kit } as SocialCreateRoutesDependencies);
  assert.ok(save);

  for (const key of ["extra", "__proto__", "constructor"]) {
    const body = { version: 0, draft: blankDraft(), [key]: {} };
    const request = new Request("https://blast.fun/api/social/me/drafts/00000000-0000-4000-8000-000000000001", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    await assert.rejects(save({ request } as SocialRequestContext), { code: "invalid_request" }, key);
  }
});
