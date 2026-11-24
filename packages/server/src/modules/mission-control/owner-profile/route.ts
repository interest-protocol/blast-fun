import { z } from "zod";
import { publicJson } from "@blast/core/lib/http-errors.ts";
import { assertTrustedMutationRequest } from "@blast/core/lib/web-security/mutation-guard.ts";
import { WebSecurityError, webSecurityErrorResponse } from "@blast/core/lib/web-security/errors.ts";
import { readBoundedText } from "@blast/server/lib/web-security/request-body.ts";
import { cardImageBody } from "@blast/core/modules/mission-control/card-images/body.ts";
import {
  MemberSessionError,
  memberSessionErrorResponse,
  type MemberAuthorization,
} from "@blast/server/modules/mission-control/member-sessions/index.ts";
import { OwnerProfileError, ownerProfileErrorResponse } from "@blast/server/modules/mission-control/owner-profile/errors.ts";
import type { OwnerProfileService } from "@blast/server/modules/mission-control/owner-profile/service.ts";

export interface OwnerRouteDependencies {
  authenticate(request: Request): Promise<MemberAuthorization>;
  expectedOrigin: string;
  service: Pick<
    OwnerProfileService,
    "getCardImage" | "getOwner" | "getRecruits" | "updateDisplayName"
  >;
}

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store");
  return publicJson(data, { ...init, headers });
}

function failure(error: unknown): Response {
  if (error instanceof WebSecurityError) return webSecurityErrorResponse(error);
  if (error instanceof MemberSessionError) return memberSessionErrorResponse(error);
  return ownerProfileErrorResponse(error);
}

async function profileId(
  request: Request,
  dependencies: OwnerRouteDependencies,
): Promise<string> {
  const authorization = await dependencies.authenticate(request);
  return authorization.profileId;
}

export function createOwnerRouteHandlers(dependencies: OwnerRouteDependencies) {
  return {
    async card(request: Request): Promise<Response> {
      try {
        const card = await dependencies.service.getCardImage(
          await profileId(request, dependencies),
          new URL(request.url).searchParams.get("format") === "share" ? "share" : "card",
        );
        const download = new URL(request.url).searchParams.get("download") === "1";
        return new Response(cardImageBody(card.image.bytes), {
          headers: {
            "Cache-Control": "private, no-store",
            "Content-Disposition": `${download ? "attachment" : "inline"}; filename="blast-season-zero-${card.callsign}.png"`,
            "Content-Length": String(card.image.bytes.byteLength),
            "Content-Type": card.image.contentType,
          },
        });
      } catch (error) {
        return failure(error);
      }
    },
    async owner(request: Request): Promise<Response> {
      try {
        return json({ owner: await dependencies.service.getOwner(
          await profileId(request, dependencies),
        ) });
      } catch (error) {
        return failure(error);
      }
    },
    async recruits(request: Request): Promise<Response> {
      try {
        const url = new URL(request.url);
        const rawLimit = url.searchParams.get("limit");
        const limit = rawLimit === null ? 10 : Number(rawLimit);
        if (!z.number().int().min(1).max(25).safeParse(limit).success) {
          throw new OwnerProfileError("CURSOR_INVALID");
        }
        return json(await dependencies.service.getRecruits(
          await profileId(request, dependencies),
          url.searchParams.get("cursor"),
          limit,
        ));
      } catch (error) {
        return failure(error);
      }
    },
    async displayName(request: Request): Promise<Response> {
      try {
        assertTrustedMutationRequest(request, dependencies.expectedOrigin);
        // At most 1 KiB is read: a larger body is refused unread (review L5).
        const raw = await readBoundedText(request, 1_024);
        if (raw === null) {
          throw new OwnerProfileError("DISPLAY_NAME_INVALID");
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new OwnerProfileError("DISPLAY_NAME_INVALID");
        }
        const body = z.strictObject({ displayName: z.unknown().nonoptional() }).safeParse(parsed);
        if (!body.success) throw new OwnerProfileError("DISPLAY_NAME_INVALID");
        const result = await dependencies.service.updateDisplayName(
          await profileId(request, dependencies),
          body.data.displayName,
        );
        return json({ profile: result });
      } catch (error) {
        return failure(error);
      }
    },
  };
}
