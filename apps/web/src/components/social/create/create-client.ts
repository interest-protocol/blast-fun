import { z } from "zod";
import { allowlistEntriesResponseSchema, allowlistResponseSchema } from "@blast/core/modules/presale/contracts/transaction-responses.ts";
import type { AllowlistEntriesResponse, AllowlistResponse } from "@blast/core/modules/presale/contracts/web-api.ts";
import { responseDiagnostic } from "#web/lib/errors.ts";
import { gatedFetch } from "#web/lib/api-gate-client.ts";
import {
  SOCIAL_CREATE_DRAFTS_PATH,
  createDraftPageSchema,
  createDraftResponseSchema,
  createSigningPublishPlanSchema,
  socialCreateDraftCoverPath,
  socialCreateDraftLogoPath,
  socialCreateDraftPath,
  socialCreateDraftPublishedPath,
  socialCreateDraftPublishPath,
  type CreateDraft,
  type CreateDraftPage,
  type CreateDraftResponse,
  type CreateSigningPublishPlan,
  type CreatePublishStep,
} from "@blast/core/web/contracts/create.ts";
import { parseDraft } from "@blast/core/modules/social/create/model.ts";
import { socialSaleMetadataResponseSchema, type SocialSaleMetadataResponse } from "@blast/core/web/contracts/sales.ts";

import { parseSocialResponse, socialErrorBody, type SocialResponseBody } from "../social-api.ts";
import { socialRequestAuth, type AccessTokenSource } from "../social-fetch";

/**
 * The Create page's calls (contract in `contracts/create.ts`), each with the
 * viewer's credentials (`socialRequestAuth`: a Privy token, else the wallet
 * session cookie), never cached. A refusal keeps its published code and the
 * fields the page acts on (`error.draft` of a conflict, `error.reasons` of
 * an unavailable publish, `error.reason` of a refused logo).
 */
export type CreateApiResult<Body> =
  | Readonly<{ status: "ok"; body: Body; httpStatus: number }>
  | Readonly<{ status: "refused"; code: string; httpStatus: number; error: Readonly<Record<string, unknown>>; requestId?: string }>
  | Readonly<{ status: "error"; code?: string; httpStatus?: number; requestId?: string }>;

export type CreateApiOptions = Readonly<{ getAccessToken: AccessTokenSource; signal?: AbortSignal; fetch?: typeof globalThis.fetch }>;

/** Wire validation precedes the existing domain normalization for legacy optional draft fields. */
const draftResponseContract: SocialResponseBody<CreateDraftResponse> = {
  safeParse(value) {
    const parsed = createDraftResponseSchema.safeParse(value);
    if (!parsed.success) return { success: false };
    try {
      return { success: true, data: { ...parsed.data, draft: parseDraft(parsed.data.draft) } };
    } catch {
      return { success: false };
    }
  },
};

export async function call<Body>(
  options: CreateApiOptions,
  path: string,
  init: Readonly<{ method: "GET" | "PUT" | "POST" | "DELETE"; json?: unknown; raw?: Blob; form?: FormData }>,
  contract: SocialResponseBody<Body>,
): Promise<CreateApiResult<Body>> {
  const auth = await socialRequestAuth(options.getAccessToken);
  if (!auth) return { status: "error", code: "authentication_unavailable" };
  const headers: Record<string, string> = { ...auth.headers };
  if (init.json !== undefined) headers["content-type"] = "application/json";
  if (init.raw) headers["content-type"] = init.raw.type;
  let response: Response;
  try {
    response = await (options.fetch ?? gatedFetch)(path, {
      method: init.method,
      cache: "no-store",
      credentials: auth.credentials,
      signal: options.signal,
      headers,
      // A form is sent as the browser encodes it (`multipart/form-data` with its boundary).
      body: init.json !== undefined ? JSON.stringify(init.json) : (init.form ?? init.raw),
    });
  } catch {
    return { status: "error", code: "network_unavailable" };
  }
  const diagnostic = responseDiagnostic(response);
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) {
    const parsed = parseSocialResponse(contract, body);
    return parsed ? { status: "ok", body: parsed.data, httpStatus: response.status } : { status: "error", code: "invalid_response", ...diagnostic };
  }
  const error = socialErrorBody(body);
  if (!error || typeof error.code !== "string") return { status: "error", code: "invalid_response", ...diagnostic };
  return { status: "refused", code: error.code, error, ...diagnostic };
}

/** Resume recent unfinished work; a completed launch starts the form over. */
export async function fetchLatestDraftId(options: CreateApiOptions): Promise<CreateApiResult<string | null>> {
  const page = await call<CreateDraftPage>(options, `${SOCIAL_CREATE_DRAFTS_PATH}?limit=1&resume=true`, { method: "GET" }, createDraftPageSchema);
  return page.status === "ok" ? { ...page, body: page.body.items[0]?.draft_id ?? null } : page;
}

export function fetchDraft(options: CreateApiOptions, draftId: string): Promise<CreateApiResult<CreateDraftResponse>> {
  return call(options, socialCreateDraftPath(draftId), { method: "GET" }, draftResponseContract);
}

/** Saves `draft` over `version` (0 creates). A conflict carries the stored draft in `error.draft`. */
export function saveDraft(options: CreateApiOptions, draftId: string, version: number, draft: CreateDraft): Promise<CreateApiResult<CreateDraftResponse>> {
  return call(options, socialCreateDraftPath(draftId), { method: "PUT", json: { version, draft } }, draftResponseContract);
}

export function deleteDraft(options: CreateApiOptions, draftId: string): Promise<CreateApiResult<null>> {
  return call(options, socialCreateDraftPath(draftId), { method: "DELETE" }, z.null());
}

export function uploadLogo(options: CreateApiOptions, draftId: string, file: Blob): Promise<CreateApiResult<CreateDraftResponse>> {
  return call(options, socialCreateDraftLogoPath(draftId), { method: "PUT", raw: file }, draftResponseContract);
}

/** R3-25: the sale's cover for the draft (`multipart/form-data`, one `cover` file); answers the draft. */
export function uploadCover(options: CreateApiOptions, draftId: string, file: Blob): Promise<CreateApiResult<CreateDraftResponse>> {
  const form = new FormData();
  form.set("cover", file);
  return call(options, socialCreateDraftCoverPath(draftId), { method: "POST", form }, draftResponseContract);
}

/** R3-25: removes the draft's cover; answers the draft. */
export function removeCover(options: CreateApiOptions, draftId: string): Promise<CreateApiResult<CreateDraftResponse>> {
  return call(options, socialCreateDraftCoverPath(draftId), { method: "DELETE" }, draftResponseContract);
}

/**
 * R3-25: once the sale's creation transaction has executed, records the sale
 * the draft became and moves its tagline, links and cover into the sale's
 * details after the confirmed `create_presale` transaction.
 */
export function recordPublished(options: CreateApiOptions, draftId: string, presaleId: string): Promise<CreateApiResult<SocialSaleMetadataResponse>> {
  return call(options, socialCreateDraftPublishedPath(draftId), { method: "POST", json: { presale_id: presaleId } }, socialSaleMetadataResponseSchema);
}

/** The presale allowlist upload (`POST /api/presale/allowlists`, a Privy sign-in only): the CSV and the Quote. */
export async function uploadAllowlist(options: CreateApiOptions, file: Blob, quote: string, includeHolders = false, fileName = "allowlist.csv"): Promise<CreateApiResult<AllowlistResponse>> {
  const auth = await socialRequestAuth(options.getAccessToken);
  if (!auth) return { status: "error", code: "authentication_unavailable" };
  if (!auth.headers.authorization) return { status: "refused", code: "unauthorized", httpStatus: 401, error: {} };
  const form = new FormData();
  form.set("file", file, fileName);
  form.set("include_blast_holders", String(includeHolders));
  form.set("quote", quote);
  let response: Response;
  try {
    response = await (options.fetch ?? gatedFetch)("/api/presale/allowlists", { method: "POST", cache: "no-store", headers: auth.headers, body: form, signal: options.signal });
  } catch {
    return { status: "error", code: "network_unavailable" };
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) {
    const parsed = allowlistResponseSchema.safeParse(body);
    if (parsed.success) return { status: "ok", body: parsed.data, httpStatus: response.status };
  }
  const diagnostic = responseDiagnostic(response);
  const error = socialErrorBody(body);
  return error && typeof error.code === "string" ? { status: "refused", code: error.code, error, ...diagnostic } : { status: "error", code: "invalid_response", ...diagnostic };
}

/** Asks for one publish step after the preceding transaction has confirmed. */
export function requestPublish(options: CreateApiOptions, draftId: string, version: number, creator: string, step: CreatePublishStep["kind"] = "publish_coin", coin?: Readonly<Record<string, unknown>>, fee?: "sponsored" | "wallet"): Promise<CreateApiResult<CreateSigningPublishPlan>> {
  return call(options, socialCreateDraftPublishPath(draftId), { method: "POST", json: { version, step, creator, ...(coin ? { coin } : {}), ...(fee ? { fee } : {}) } }, createSigningPublishPlanSchema);
}

export function fetchAllowlistEntries(options: CreateApiOptions, id: string): Promise<CreateApiResult<AllowlistEntriesResponse>> {
  return call(options, `/api/presale/allowlists/${encodeURIComponent(id)}/entries`, { method: "GET" }, allowlistEntriesResponseSchema);
}
