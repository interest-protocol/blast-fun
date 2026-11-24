import { diagnosticMessage } from "#web/lib/errors.ts";
import { responseDiagnostic } from "#web/lib/errors.ts";
import { gatedFetch } from "#web/lib/api-gate-client.ts";
import {
  SOCIAL_FOLLOW_LIMIT,
  socialFollowPath,
  type SocialFollowTarget,
} from "@blast/core/web/contracts/follows.ts";
import { socialReactionPath } from "@blast/core/web/contracts/item-routes.ts";
import {
  SOCIAL_VIEWER_STATE_PATH,
  socialViewerStateResponseSchema,
  VIEWER_STATE_MAX_IDS,
  type SocialViewerStateRequest,
  type SocialViewerStateResponse,
} from "@blast/core/web/contracts/viewer-state.ts";

import { socialRequestAuth, type AccessTokenSource } from "./social-fetch";

/** The kit refuses a larger body (`body_too_large`), so batches stay under it. */
const BODY_LIMIT_BYTES = 4 * 1_024;

export type { AccessTokenSource } from "./social-fetch";

/** A failed call: a published refusal with its code (and `Retry-After` seconds), or anything else. */
export type SocialCallFailure =
  | Readonly<{
      status: "refused";
      code: string;
      retryAfterSeconds: number | null;
      httpStatus?: number;
      requestId?: string;
    }>
  | Readonly<{
      status: "error";
      code?: string;
      httpStatus?: number;
      requestId?: string;
    }>;

export type FollowWriteResult = Readonly<{ status: "ok" }> | SocialCallFailure;
export type ReactionWriteResult = Readonly<{ status: "ok" }> | SocialCallFailure;
export type ViewerStateResult =
  | Readonly<{ status: "ok"; state: SocialViewerStateResponse }>
  | SocialCallFailure;

/** Ids a screen wants the viewer's state for. */
export type ViewerStateWants = Readonly<{
  entryIds?: readonly string[];
  callsigns?: readonly string[];
  presaleIds?: readonly string[];
  /** Presales whose followed backers a facepile shows. */
  backersOf?: readonly string[];
  /** Accounts whose "Follows you" tag the live tape shows. */
  followsYou?: readonly string[];
}>;

async function failure(response: Response): Promise<SocialCallFailure> {
  const diagnostic = responseDiagnostic(response);
  const body: unknown = await response.json().catch(() => null);
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  if (typeof code !== "string") return { status: "error", code: "invalid_response", ...diagnostic };
  const retryAfter = Number(response.headers.get("retry-after"));
  return {
    status: "refused",
    code,
    ...diagnostic,
    retryAfterSeconds: Number.isSafeInteger(retryAfter) && retryAfter > 0 ? retryAfter : null,
  };
}

/**
 * Calls `url` as the viewer (`socialRequestAuth`: a Privy token, else the
 * wallet session cookie); a failing token source or network is `error`.
 */
async function authorized(
  getAccessToken: AccessTokenSource,
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<Response | SocialCallFailure> {
  const auth = await socialRequestAuth(getAccessToken);
  if (!auth) return { status: "error", code: "authentication_unavailable" };
  try {
    return await fetchImpl(url, {
      ...init,
      cache: "no-store",
      credentials: auth.credentials,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        ...auth.headers,
      },
    });
  } catch {
    return { status: "error", code: "network_unavailable" };
  }
}

/** `PUT` (follow) or `DELETE` (unfollow) of `target`; `204` is `ok`. */
export async function writeFollow(
  input: Readonly<{
    getAccessToken: AccessTokenSource;
    target: SocialFollowTarget;
    following: boolean;
    fetch?: typeof fetch;
  }>,
): Promise<FollowWriteResult> {
  const response = await authorized(
    input.getAccessToken,
    socialFollowPath(input.target),
    { method: input.following ? "PUT" : "DELETE" },
    input.fetch ?? gatedFetch,
  );
  if (!(response instanceof Response)) return response;
  if (response.status === 204) return { status: "ok" };
  return failure(response);
}

/** `PUT` (add) or `DELETE` (remove) of the caller's `reaction` on `entryId` (T-010); `204` is `ok`. */
export async function writeReaction(
  input: Readonly<{
    getAccessToken: AccessTokenSource;
    entryId: string;
    reaction: string;
    on: boolean;
    fetch?: typeof fetch;
  }>,
): Promise<ReactionWriteResult> {
  const response = await authorized(
    input.getAccessToken,
    socialReactionPath(input.entryId, input.reaction),
    { method: input.on ? "PUT" : "DELETE" },
    input.fetch ?? gatedFetch,
  );
  if (!(response instanceof Response)) return response;
  if (response.status === 204) return { status: "ok" };
  return failure(response);
}

/** `POST /api/social/viewer-state` with one batch (see `viewerStateBatches`). */
export async function fetchViewerState(
  input: Readonly<{
    getAccessToken: AccessTokenSource;
    request: SocialViewerStateRequest;
    fetch?: typeof fetch;
    signal?: AbortSignal;
  }>,
): Promise<ViewerStateResult> {
  const response = await authorized(
    input.getAccessToken,
    SOCIAL_VIEWER_STATE_PATH,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(input.request),
      signal: input.signal,
    },
    input.fetch ?? gatedFetch,
  );
  if (!(response instanceof Response)) return response;
  if (response.status !== 200) return failure(response);
  const diagnostic = responseDiagnostic(response);
  const body: unknown = await response.json().catch(() => null);
  const parsed = socialViewerStateResponseSchema.safeParse(body);
  return parsed.success
    ? { status: "ok", state: parsed.data }
    : { status: "error", code: "invalid_response", ...diagnostic };
}

type ListKey = "entry_ids" | "callsigns" | "presale_ids" | "backers_of" | "follows_you";

/**
 * Splits wanted ids into viewer-state request bodies the route accepts: at
 * most `VIEWER_STATE_MAX_IDS` ids per list and at most 4 KiB of JSON each.
 * Ids are deduplicated and keep their order.
 */
export function viewerStateBatches(wants: ViewerStateWants): SocialViewerStateRequest[] {
  const lists: ReadonlyArray<readonly [ListKey, readonly string[]]> = [
    ["entry_ids", [...new Set(wants.entryIds ?? [])]],
    ["callsigns", [...new Set(wants.callsigns ?? [])]],
    ["presale_ids", [...new Set(wants.presaleIds ?? [])]],
    ["backers_of", [...new Set(wants.backersOf ?? [])]],
    ["follows_you", [...new Set(wants.followsYou ?? [])]],
  ];
  const batches: SocialViewerStateRequest[] = [];
  let current: Partial<Record<ListKey, string[]>> = {};
  const size = (body: Partial<Record<ListKey, string[]>>) => JSON.stringify(body).length;
  for (const [key, ids] of lists) {
    for (const id of ids) {
      const candidate = { ...current, [key]: [...(current[key] ?? []), id] };
      if (
        (candidate[key]?.length ?? 0) > VIEWER_STATE_MAX_IDS ||
        size(candidate) > BODY_LIMIT_BYTES
      ) {
        if (Object.keys(current).length > 0) batches.push(current);
        current = { [key]: [id] };
      } else {
        current = candidate;
      }
    }
  }
  if (Object.keys(current).length > 0) batches.push(current);
  return batches;
}

/** The copy for a failed rocket: what happened; the count and the button are back as they were. */
export function reactionErrorMessage(result: SocialCallFailure): string {
  if (result.status === "refused") {
    switch (result.code) {
      case "unauthorized":
        return diagnosticMessage("Your session ended. Sign in again to react.", result);
      case "account_required":
        return diagnosticMessage("Finish creating your Blast account to react.", result);
      case "not_found":
        return diagnosticMessage("This post is no longer available.", result);
      case "rate_limited":
        return diagnosticMessage("Too many reactions in a short time. Try again shortly.", result);
      default:
        break;
    }
  }
  return diagnosticMessage("Your rocket did not go through. Try again.", result);
}

/** The copy for a failed follow or unfollow: what happened and what to do; nothing changed. */
export function followErrorMessage(result: SocialCallFailure, following: boolean): string {
  const nothing = following ? "You are not following it." : "You are still following it.";
  if (result.status === "refused") {
    switch (result.code) {
      case "follow_limit":
        return diagnosticMessage(
          `You follow ${SOCIAL_FOLLOW_LIMIT.toLocaleString("en-US")} accounts and presales, the most allowed. Unfollow one first.`,
          result,
        );
      case "cannot_follow_self":
        return diagnosticMessage("You cannot follow yourself.", result);
      case "not_found":
        return diagnosticMessage("This account or presale no longer exists.", result);
      case "account_required":
        return diagnosticMessage("Finish creating your Blast account to follow.", result);
      case "unauthorized":
        return diagnosticMessage(`Your session ended. Sign in again. ${nothing}`, result);
      case "rate_limited":
        return diagnosticMessage(
          result.retryAfterSeconds
            ? `Too many follows in a short time. Try again in ${result.retryAfterSeconds} seconds. ${nothing}`
            : `Too many follows in a short time. Try again shortly. ${nothing}`,
          result,
        );
      default:
        break;
    }
  }
  return diagnosticMessage(`That did not go through. ${nothing} Try again.`, result);
}
