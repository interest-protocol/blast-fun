import { clearMemberSessionCookie } from "@blast/server/modules/mission-control/member-sessions/cookies.ts";
import { memberSessionErrorResponse } from "@blast/server/modules/mission-control/member-sessions/errors.ts";
import {
  revokeMemberSession,
  type MemberSessionService,
} from "@blast/server/modules/mission-control/member-sessions/service.ts";

export function createMemberSessionLogoutHandler(input: {
  expectedOrigin: string;
  service: Pick<MemberSessionService, "revoke">;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      await revokeMemberSession(
        request,
        input.expectedOrigin,
        input.service,
      );
      return new Response(null, {
        status: 204,
        headers: {
          "Cache-Control": "no-store",
          "Set-Cookie": clearMemberSessionCookie(),
        },
      });
    } catch (error) {
      return memberSessionErrorResponse(error);
    }
  };
}
