import { diagnosticMessage } from "#web/lib/errors.ts";
import { SOCIAL_DISPLAY_NAME_MAX_CODE_POINTS } from "@blast/core/web/contracts/accounts.ts";
import { PROFILE_PICTURE_TYPES } from "@blast/core/web/contracts/profile-page.ts";

import type { ApiResult } from "#web/components/social/social-api.ts";

/**
 * The edit sheet's rules and copy (OA-14). The server applies the same
 * rules (`profile-edit/route.ts`); these only answer early.
 */

export type PictureChange =
  | Readonly<{ kind: "keep" }>
  | Readonly<{ kind: "source" }>
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "upload"; blob: Blob; preview: string }>;

const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export type NameCheck = Readonly<{ state: "ok" | "bad"; length: number; message: string }>;

/**
 * The name as typed: its length in code points after trimming, whether it can
 * be saved, and the line under the field (the gate's: the handle that stays, or
 * why the name cannot be saved).
 */
export function nameCheck(value: string, handle?: string): NameCheck {
  const name = value.trim().replace(/\s+/gu, " ");
  const length = [...name].length;
  if (length === 0) return { state: "bad", length, message: "Your name can’t be empty." };
  if (length > SOCIAL_DISPLAY_NAME_MAX_CODE_POINTS) return { state: "bad", length, message: `Use at most ${SOCIAL_DISPLAY_NAME_MAX_CODE_POINTS} characters.` };
  if (CONTROL.test(name)) return { state: "bad", length, message: "Use letters, numbers, spaces and punctuation only." };
  return { state: "ok", length, message: handle ? `Your handle stays @${handle}.` : "Your display name doesn't need to be unique." };
}

/** What a refused save says. */
export function editRefusalMessage(result: ApiResult<unknown>): string {
  if (result.status === "error") return diagnosticMessage("Nothing was saved. Check your connection and try again.", result);
  if (result.status === "ok") return "";
  switch (result.code) {
    case "invalid_display_name":
      return diagnosticMessage(`Use a display name of 1 to ${SOCIAL_DISPLAY_NAME_MAX_CODE_POINTS} characters.`, result);
    case "callsign_taken":
      return diagnosticMessage("That call sign was taken. Pick another one.", result);
    case "callsign_reserved":
      return diagnosticMessage("That call sign is reserved. Pick another one.", result);
    case "invalid_callsign":
      return diagnosticMessage("Use a call sign of 3 to 20 letters, numbers or underscores.", result);
    case "blocked_term":
      return diagnosticMessage("Your profile contains a word that is not allowed.", result);
    case "invalid_image":
      return diagnosticMessage("Use a still PNG, JPEG or WebP image of at least 64 pixels on each side.", result);
    case "body_too_large":
      return diagnosticMessage("That image is too large. Use one under 2 MB.", result);
    case "picture_upload_unavailable":
      return diagnosticMessage("Photo uploads are not available right now. Nothing was saved.", result);
    case "rate_limited":
      return diagnosticMessage("Too many changes. Try again later.", result);
    case "unauthorized":
      return diagnosticMessage("Sign in again to save your profile.", result);
    default:
      return diagnosticMessage("Nothing was saved. Try again.", result);
  }
}

export type PreparedPicture = Readonly<{ ok: true; blob: Blob }> | Readonly<{ ok: false; message: string }>;

const SIDE = 512;

/**
 * Makes an upload of a chosen file: the centre square, 512 pixels, as WebP
 * (JPEG where the browser cannot encode WebP), so a phone photo of many
 * megabytes becomes a small file. The server decodes and re-encodes it again.
 */
export async function preparePicture(file: File, maxBytes: number): Promise<PreparedPicture> {
  if (!(PROFILE_PICTURE_TYPES as readonly string[]).includes(file.type)) return { ok: false, message: "Use a PNG, JPEG or WebP image." };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { ok: false, message: "This image could not be read. Try another one." };
  }
  if (bitmap.width < 64 || bitmap.height < 64) {
    bitmap.close();
    return { ok: false, message: "Use an image of at least 64 pixels on each side." };
  }
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = Math.min(SIDE, side);
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    return { ok: false, message: "This image could not be read. Try another one." };
  }
  context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const encode = (type: string) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.9));
  let blob = await encode("image/webp");
  if (!blob || blob.type !== "image/webp") blob = await encode("image/jpeg");
  if (!blob) return { ok: false, message: "This image could not be read. Try another one." };
  if (blob.size > maxBytes) return { ok: false, message: "That image is too large. Use one under 2 MB." };
  return { ok: true, blob };
}
