import { z } from "zod";
import { socialInput } from "@blast/server/modules/social/route-kit/validation.ts";
import { timed } from "@blast/core/lib/metrics.ts";
import type { ModuleTransaction, ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { BlockedTermFinder } from "@blast/server/modules/social/accounts/creation.ts";
import { blockedTerm } from "@blast/server/modules/social/accounts/creation.ts";
import { callsignUnavailableReason, callsignRefusal, insertRefusal } from "@blast/server/modules/social/accounts/creation.ts";
import { isSocialCallsign, normalizeSocialCallsign, SOCIAL_DISPLAY_NAME_MAX_CODE_POINTS } from "@blast/core/modules/social/contracts/accounts.ts";
import {
  PROFILE_PICTURE_MAX_BYTES,
  socialProfileEditRequestSchema,
  SOCIAL_PROFILE_EDIT_READ_ROUTE,
  SOCIAL_PROFILE_EDIT_ROUTE,
  SOCIAL_PROFILE_PICTURE_ROUTE,
  type ProfilePictureChoice,
  type SocialProfileEdit,
} from "@blast/core/modules/social/contracts/profile-page.ts";
import { normalizeProfileBio, profileBioRequested } from "@blast/core/modules/social/contracts/profiles.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import type { SocialAccount } from "@blast/core/modules/social/contracts/me.ts";
import { readSocialBody, readSocialJson, type SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { sanitizeSquareImage, storeSquareImage } from "@blast/server/modules/social/square-image.ts";
import { PROFILE_PICTURE_IMAGE } from "@blast/server/modules/social/profile-edit/picture.ts";
import { PROFILE_PICTURE_FOLDER, type ProfilePictureStore } from "@blast/server/modules/social/profile-edit/store.ts";

type EditRow = {
  callsign: string;
  callsign_editable: boolean;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  picture: "upload" | "none" | null;
  source_avatar_url: string | null;
};

/**
 * The sheet's view of the account: the shown name and picture (the public
 * identity, `social_account_identities`), the account's own picture choice,
 * and its source's picture (a new account's X avatar, a member's profile or
 * X avatar; none for a wallet-only account).
 */
const READ_EDIT = `
  SELECT i.callsign, a.profile_id IS NULL AS callsign_editable, i.display_name, a.bio, i.avatar_url, a.picture,
    CASE WHEN a.profile_id IS NULL THEN a.x_avatar_url ELSE COALESCE(p.avatar_reference, p.x_avatar_reference) END
      AS source_avatar_url
  FROM social_accounts a
  JOIN social_account_identities i ON i.account_id = a.account_id
  LEFT JOIN mission_control_profiles p ON p.profile_id = a.profile_id
  WHERE a.account_id = $1`;

/** Null parameters keep their fields. An empty bio clears it. */
const UPDATE_EDIT = `
  UPDATE social_accounts SET
    display_name = COALESCE($2::text, display_name),
    picture = CASE WHEN $3::text IS NULL THEN picture WHEN $3::text = 'none' THEN 'none' ELSE NULL END,
    picture_url = CASE WHEN $3::text IS NULL THEN picture_url ELSE NULL END,
    bio = CASE WHEN $4::text IS NULL THEN bio ELSE NULLIF($4::text, '') END,
    profile_updated_at = now()
  WHERE account_id = $1`;

const UPDATE_PICTURE = `
  UPDATE social_accounts SET picture = 'upload', picture_url = $2, profile_updated_at = now()
  WHERE account_id = $1`;

const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * A display name as stored: trimmed, inner whitespace runs as one space, 1
 * to 32 code points, no control or format characters; null when invalid.
 * (Onboarding's rule, `normalizeSocialDisplayName`, plus the whitespace and
 * control-character rules Mission Control's name editor applies.)
 */
export const editableDisplayNameSchema = z.string().transform((value) => value.trim().replace(/\s+/gu, " "))
  .refine((name) => !CONTROL.test(name) && [...name].length >= 1 && [...name].length <= SOCIAL_DISPLAY_NAME_MAX_CODE_POINTS);

export function editableDisplayName(value: unknown): string | null {
  const parsed = editableDisplayNameSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function editOf(row: EditRow, uploadAvailable: boolean, includeBio: boolean): SocialProfileEdit {
  const picture: ProfilePictureChoice = row.picture === "upload" ? "upload" : row.picture === "none" ? "none" : "source";
  return {
    callsign: row.callsign,
    callsign_editable: row.callsign_editable,
    display_name: row.display_name,
    ...(includeBio && row.bio !== null ? { bio: row.bio } : {}),
    picture,
    avatar_url: row.avatar_url,
    source_avatar_url: row.source_avatar_url,
    upload_available: uploadAvailable,
  };
}

async function readEdit(db: ReadableDatabase, accountId: string, uploadAvailable: boolean, includeBio: boolean): Promise<SocialProfileEdit> {
  const row = (await db.read<EditRow>(READ_EDIT, [accountId])).rows[0];
  if (!row) throw new Error("The profile edit read matched no account.");
  return editOf(row, uploadAvailable, includeBio);
}

async function changeCallsign(social: ModuleTransaction<"social">, accountId: string, callsign: string, findBlockedTerm: BlockedTermFinder): Promise<void> {
  await social.read("SELECT account_id FROM social_accounts WHERE account_id = $1 FOR UPDATE", [accountId]);
  const reason = await callsignUnavailableReason(social, callsign, findBlockedTerm, accountId);
  if (reason) throw callsignRefusal(reason);
  try {
    await social.write("social_accounts", "UPDATE social_accounts SET callsign = $2, profile_updated_at = now() WHERE account_id = $1 AND callsign IS DISTINCT FROM $2", [accountId, callsign]);
  } catch (error) {
    throw insertRefusal(error) ?? error;
  }
}

function editableCallsign(value: unknown, account: SocialAccount): string | null {
  if (value === undefined) return null;
  const callsign = normalizeSocialCallsign(socialInput(z.string(), value, "invalid_callsign"));
  if (!isSocialCallsign(callsign)) throw new SocialRouteError("invalid_callsign");
  if (account.kind === "member" && callsign !== account.callsign) throw new SocialRouteError("invalid_request");
  return callsign;
}

export type SocialProfileEditRouteDependencies = Readonly<{
  kit: SocialRouteKit;
  findBlockedTerm: BlockedTermFinder;
  /** The public picture store, or null when uploads are off. Resolved per request. */
  store: () => ProfilePictureStore | null;
}>;

/**
 * The own profile's edit sheet (OA-14; contract in
 * `contracts/profile-page.ts`), on the primary, for any signed-in account
 * (an X, Google, EVM, Solana or wallet-only account alike):
 *
 * - `GET /api/social/me/profile`: what the sheet shows.
 * - `PUT /api/social/me/profile` `{ callsign?, display_name?, bio?, picture? }`: bucket
 *   `social_account_update`; closed body (`invalid_request`), the name
 *   (`invalid_display_name`, then `blocked_term`), then one update. The
 *   answer is the sheet's state after it. Only social accounts can rename
 *   callsigns; old names stay owned by that account and resolve to it.
 * - `PUT /api/social/me/profile/picture`: the image as the body (its
 *   `Content-Type`), at most 2 MiB; bucket `social_picture_upload`. Decoded
 *   and re-encoded outside any transaction (`invalid_image`), stored at its
 *   content address (`picture_upload_unavailable` without a store or when the
 *   store fails), then one update.
 *
 * The public identity reads the new name and picture at once; shared caches
 * of public profile reads may show the old ones for up to 30 s.
 */
export function createSocialProfileEditRoutes(dependencies: SocialProfileEditRouteDependencies) {
  const { kit, findBlockedTerm, store } = dependencies;
  const spec = { auth: "account", account: "required", cache: "private" } as const;
  const label = { label: "social.profile_edit" } as const;

  return Object.freeze({
    profile: Object.freeze({
      GET: kit.route({ ...spec, name: SOCIAL_PROFILE_EDIT_READ_ROUTE, bucket: "social_me_read" }, async (context) => {
        const accountId = context.account!.account_id;
        const edit = await timed("social.profile_edit", () =>
          context.transaction((social) => readEdit(social, accountId, store() !== null, profileBioRequested(context.request)), label),
        { operation: "read" }, { sampleRate: 0.1 });
        return context.json(edit);
      }),
      PUT: kit.route({ ...spec, name: SOCIAL_PROFILE_EDIT_ROUTE, bucket: "social_account_update" }, async (context) => {
        const body = await readSocialJson(context.request, [], ["callsign", "display_name", "bio", "picture"]);
        const callsign = editableCallsign(body.callsign, context.account!);
        if (!socialProfileEditRequestSchema.shape.picture.safeParse(body.picture).success) {
          throw new SocialRouteError("invalid_request");
        }
        const bioInput = socialInput(socialProfileEditRequestSchema.shape.bio, body.bio);
        const bio = bioInput === undefined ? null : normalizeProfileBio(bioInput);
        if (bio && /[\p{Cc}\p{Cs}]/u.test(bio)) throw new SocialRouteError("invalid_request");
        let name: string | null = null;
        if (body.display_name !== undefined) {
          name = editableDisplayName(body.display_name);
          if (name === null) throw new SocialRouteError("invalid_display_name");
          if ((await findBlockedTerm(name)) !== null) throw blockedTerm("display_name");
        }
        if (bio && (await findBlockedTerm(bio)) !== null) {
          throw new SocialRouteError("blocked_term", { extra: { field: "bio" } });
        }
        const picture = (body.picture as "source" | "none" | undefined) ?? null;
        const accountId = context.account!.account_id;
        const edit = await timed("social.profile_edit", () =>
          context.transaction(async (social: ModuleTransaction<"social">) => {
            if (callsign !== null && context.account!.kind === "new") await changeCallsign(social, accountId, callsign, findBlockedTerm);
            if (name !== null || picture !== null || bio !== null) {
              await social.write("social_accounts", UPDATE_EDIT, [accountId, name, picture, bio]);
            }
            return readEdit(social, accountId, store() !== null, profileBioRequested(context.request));
          }, { ...label, isolationLevel: "READ COMMITTED" }),
        { operation: "write", fields: [callsign !== null && "callsign", name !== null && "display_name", bio !== null && "bio", picture !== null && "picture"].filter(Boolean).join(",") || "none" });
        return context.json(edit);
      }),
    }),
    picture: Object.freeze({
      PUT: kit.route({ ...spec, name: SOCIAL_PROFILE_PICTURE_ROUTE, bucket: "social_picture_upload" }, async (context) => {
        const target = store();
        if (!target) throw new SocialRouteError("picture_upload_unavailable");
        const declared = context.request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
        const bytes = await readSocialBody(context.request, PROFILE_PICTURE_MAX_BYTES);
        const accountId = context.account!.account_id;
        const edit = await timed("social.profile_picture", async () => {
          const sanitized = await sanitizeSquareImage(bytes, declared, PROFILE_PICTURE_IMAGE);
          if (!sanitized.ok) throw new SocialRouteError("invalid_image", { extra: { reason: sanitized.reason } });
          const url = await storeSquareImage(target, PROFILE_PICTURE_FOLDER, sanitized);
          if (!url) throw new SocialRouteError("picture_upload_unavailable");
          return context.transaction(async (social) => {
            await social.write("social_accounts", UPDATE_PICTURE, [accountId, url]);
            return readEdit(social, accountId, true, profileBioRequested(context.request));
          }, label);
        }, { operation: "upload" });
        return context.json(edit);
      }),
    }),
  });
}
