import { z } from "zod";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

import type { RecruitCursorPosition } from "@blast/core/modules/mission-control/owner-profile/contracts.ts";

const CURSOR_VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function exactKey(value: Uint8Array): Buffer {
  if (value.byteLength !== 32) throw new TypeError("Owner cursor key must contain 32 bytes.");
  return Buffer.from(value);
}

function validPosition(value: unknown): value is RecruitCursorPosition {
  return z.strictObject({
    completedAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
    profileId: z.string().regex(UUID),
  }).safeParse(value).success;
}

export class OwnerRecruitCursorCodec {
  readonly #iv: () => Buffer;
  readonly #key: Buffer;

  constructor(key: Uint8Array, iv: () => Buffer = () => randomBytes(12)) {
    this.#key = exactKey(key);
    this.#iv = iv;
  }

  encode(position: RecruitCursorPosition): string {
    if (!validPosition(position)) throw new TypeError("Invalid recruit cursor position.");
    const iv = this.#iv();
    if (iv.byteLength !== 12) throw new TypeError("Owner cursor IV must contain 12 bytes.");
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const payload = Buffer.from(JSON.stringify({ v: CURSOR_VERSION, ...position }));
    const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted]
      .map((part) => part.toString("base64url"))
      .join(".");
  }

  decode(cursor: string): RecruitCursorPosition | null {
    try {
      if (cursor.length > 512) return null;
      const parts = cursor.split(".");
      if (parts.length !== 3) return null;
      const [ivPart, tagPart, encryptedPart] = parts;
      if (!ivPart || !tagPart || !encryptedPart) return null;
      const iv = Buffer.from(ivPart, "base64url");
      const tag = Buffer.from(tagPart, "base64url");
      const encrypted = Buffer.from(encryptedPart, "base64url");
      if (iv.byteLength !== 12 || tag.byteLength !== 16 || encrypted.byteLength === 0) return null;
      const decipher = createDecipheriv("aes-256-gcm", this.#key, iv);
      decipher.setAuthTag(tag);
      const decoded = JSON.parse(
        Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8"),
      ) as Record<string, unknown>;
      if (decoded.v !== CURSOR_VERSION) return null;
      const position = {
        completedAt: decoded.completedAt,
        profileId: decoded.profileId,
      };
      return validPosition(position) ? position : null;
    } catch {
      return null;
    }
  }
}
