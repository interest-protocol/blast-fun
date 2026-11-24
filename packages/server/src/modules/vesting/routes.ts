import type { ClientAddress } from "@blast/core/lib/web-security/client-address.ts";
import { routeSegments } from "@blast/core/modules/backend-api/route-path.ts";
import { SOCIAL_VESTING_ATTEMPT_PATH } from "@blast/core/modules/backend-api/private/financial-contracts.ts";
import { VestingReadError } from "@blast/core/modules/vesting/errors.ts";
import { z } from "zod";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";
import { refreshPendingVestings } from "./refresh-pending.ts";
import type { SocialRouteSpec } from "@blast/server/modules/social/route-kit/contracts.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import type { SocialRouteHandler } from "@blast/server/modules/social/route-kit/route.ts";
import { sharedSocialRouteKit } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { blastWalletOf } from "@blast/server/modules/social/coins/runtime.ts";
import { vestingIntentSchema } from "@blast/core/modules/vesting/model.ts";
import { canCancel, prepareVesting, refreshVesting } from "@blast/server/modules/vesting/transactions.ts";
import { walletVestings } from "@blast/server/modules/vesting/read.ts";

const requestId = z.string().uuid();

/** Builds the route on its first request, so importing this module reads no configuration. */
function lazyRoute(spec: SocialRouteSpec, handler: SocialRouteHandler) {
  let route: ((request: Request, client: ClientAddress) => Promise<Response>) | undefined;
  return (request: Request, client: ClientAddress) => (route ??= sharedSocialRouteKit().route(spec, handler))(request, client);
}

/** Custom schedules can contain 256 checkpoints, larger than the social 4 KiB default. */
async function readIntent(request: Request) {
  if (
    request.headers.get("content-type")?.split(";")[0] !== "application/json" ||
    !request.body
  )
    throw new SocialRouteError("invalid_request");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 65_536) {
        await reader.cancel();
        throw new SocialRouteError("body_too_large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const parsed = vestingIntentSchema.safeParse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    if (!parsed.success) throw new SocialRouteError("invalid_request");
    return parsed.data;
  } catch (error) {
    if (error instanceof SocialRouteError) throw error;
    throw new SocialRouteError("invalid_request");
  } finally {
    reader.releaseLock();
  }
}
export const vestingAttemptRoute = lazyRoute(
  {
    name: "PUT /api/social/me/vesting/attempts/:id",
    auth: "account",
    account: "required",
    bucket: "social_claim",
    cache: "private",
  },
  async (context) => {
    const parsed = requestId.safeParse(
      routeSegments(SOCIAL_VESTING_ATTEMPT_PATH, new URL(context.request.url).pathname)?.requestId,
    );
    if (!parsed.success) throw new SocialRouteError("invalid_parameter");
    return context.json(
      context.request.method === "GET"
        ? await refreshVesting(context, parsed.data)
        : await prepareVesting(
            context,
            parsed.data,
            await readIntent(context.request),
          ),
    );
  },
);
export const myVestingsRoute = lazyRoute(
  {
    name: "GET /api/social/me/vesting",
    auth: "account",
    account: "required",
    bucket: "social_read",
    cache: "private",
  },
  async (context) => {
    const wallet = await blastWalletOf(context.caller!);
    if (!wallet) return context.json({ wallet: null, schedules: [] });
    const scheduleId = new URL(context.request.url).searchParams.get(
      "schedule_id",
    );
    if (scheduleId) {
      if (!SUI_OBJECT_ID_PATTERN.test(scheduleId))
        throw new SocialRouteError("invalid_parameter");
      try {
        return context.json({
          wallet,
          can_cancel: (await canCancel(scheduleId, wallet)) !== null,
        });
      } catch (error) {
        if (error instanceof VestingReadError && error.reason === "authority_unavailable")
          throw new SocialRouteError("service_unavailable", {
            extra: { reasons: ["vesting_authority_unavailable"] },
          });
        throw error;
      }
    }
    // Resume settlement for a client that disappeared after its wallet signed.
    const pending = await context.transaction(
      async (db) =>
        (
          await db.read<{ request_id: string }>(
            `SELECT a.request_id FROM social_vesting_attempts a JOIN social_transactions t ON t.tx_id=a.request_id WHERE a.account_id=$1 AND t.state='submitted' ORDER BY t.created_at_ms DESC LIMIT 25`,
            [context.account!.account_id],
          )
        ).rows,
    );
    await refreshPendingVestings(pending, (attempt) =>
      refreshVesting(context, attempt.request_id),
      context.request.signal,
    );
    try {
      return context.json({ wallet, schedules: await walletVestings(wallet) });
    } catch (error) {
      if (
        error instanceof VestingReadError &&
        error.reason === "index_unavailable"
      )
        throw new SocialRouteError("service_unavailable", {
          extra: { reasons: ["vesting_index_unavailable"] },
        });
      throw error;
    }
  },
);
