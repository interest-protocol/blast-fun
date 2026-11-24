import { accountIdOf } from "../accounts/lookup.ts";
import { presaleExists } from "@blast/server/modules/social/read-model/presale-lookup.ts";
import { followableAccountIdOf, follow, unfollow } from "./store.ts";
import { SOCIAL_CALLSIGN_PATTERN } from "@blast/core/modules/social/contracts/accounts.ts";
import { z } from "zod";
import {
  SOCIAL_FOLLOW_ACCOUNT_PREFIX,
  SOCIAL_FOLLOW_ACCOUNT_ROUTE,
  SOCIAL_FOLLOW_PRESALE_PREFIX,
  SOCIAL_FOLLOW_PRESALE_ROUTE,
} from "@blast/core/modules/social/contracts/follows.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import type { SocialRequestContext, SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

/**
 * The follow target in the request path: the one segment after `prefix`,
 * URL-decoded. Anything else (no segment, more segments, bad escapes, a value
 * `pattern` refuses) is `invalid_parameter` naming `parameter`.
 */
export function followPathParameter(request: Request, prefix: string, pattern: RegExp, parameter: string): string {
  const pathname = new URL(request.url).pathname;
  const raw = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : "";
  let value: string | null = null;
  if (raw !== "" && !raw.includes("/")) {
    try {
      value = decodeURIComponent(raw);
    } catch {
      value = null;
    }
  }
  const parsed = z.string().regex(pattern).safeParse(value);
  if (!parsed.success) throw new SocialRouteError("invalid_parameter", { extra: { parameter } });
  return parsed.data;
}

/** A `204` with the kit's headers for a `no-store` route. */
function noContent(context: SocialRequestContext): Response {
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store", "X-Request-ID": context.requestId } });
}

/**
 * The follow routes (contract in `contracts/follows.ts`). Each request, after
 * the kit (auth, `social_follow`, account required): the path parameter
 * (`invalid_parameter`), then one primary transaction that resolves the
 * target (`not_found`), refuses oneself (`cannot_follow_self`) and writes.
 * No route takes an address.
 */
export function createSocialFollowRoutes(dependencies: Readonly<{ kit: SocialRouteKit }>) {
  const { kit } = dependencies;
  const spec = (method: "PUT" | "DELETE", path: string) =>
    ({ name: `${method} ${path}`, auth: "account", account: "required", bucket: "social_follow" }) as const;
  const label = { label: "social.follow" } as const;

  const callsignOf = (request: Request) =>
    followPathParameter(request, SOCIAL_FOLLOW_ACCOUNT_PREFIX, SOCIAL_CALLSIGN_PATTERN, "callsign");
  const presaleIdOf = (request: Request) =>
    followPathParameter(request, SOCIAL_FOLLOW_PRESALE_PREFIX, SUI_OBJECT_ID_PATTERN, "presale_id");

  return Object.freeze({
    account: Object.freeze({
      PUT: kit.route(spec("PUT", SOCIAL_FOLLOW_ACCOUNT_ROUTE), async (context) => {
        const callsign = callsignOf(context.request);
        const followerId = context.account!.account_id;
        await context.transaction(async (social) => {
          const targetId = await followableAccountIdOf(social, callsign);
          if (targetId === null) throw new SocialRouteError("not_found");
          if (targetId === followerId) throw new SocialRouteError("cannot_follow_self");
          await follow(social, followerId, "account", targetId);
        }, label);
        return noContent(context);
      }),
      DELETE: kit.route(spec("DELETE", SOCIAL_FOLLOW_ACCOUNT_ROUTE), async (context) => {
        const callsign = callsignOf(context.request);
        const followerId = context.account!.account_id;
        await context.transaction(async (social) => {
          const targetId = await accountIdOf(social, callsign);
          if (targetId === null) throw new SocialRouteError("not_found");
          await unfollow(social, followerId, "account", targetId);
        }, label);
        return noContent(context);
      }),
    }),
    presale: Object.freeze({
      PUT: kit.route(spec("PUT", SOCIAL_FOLLOW_PRESALE_ROUTE), async (context) => {
        const presaleId = presaleIdOf(context.request);
        const followerId = context.account!.account_id;
        await context.transaction(async (social) => {
          if (!(await presaleExists(social, presaleId))) throw new SocialRouteError("not_found");
          await follow(social, followerId, "presale", presaleId);
        }, label);
        return noContent(context);
      }),
      DELETE: kit.route(spec("DELETE", SOCIAL_FOLLOW_PRESALE_ROUTE), async (context) => {
        const presaleId = presaleIdOf(context.request);
        const followerId = context.account!.account_id;
        await context.transaction((social) => unfollow(social, followerId, "presale", presaleId), label);
        return noContent(context);
      }),
    }),
  });
}

export type SocialFollowRoutes = ReturnType<typeof createSocialFollowRoutes>;
