import { z } from "zod";
import { createHash } from "node:crypto";
import { cardEditionForCrew, type CardEdition } from "@blast/core/modules/mission-control/card-renderer/editions.ts";

export const SEASON_ZERO_CARD_SCHEMA = "blast.season-zero-card" as const;
export const SEASON_ZERO_CARD_VERSION = 3 as const;

export const CARD_TITLES = [
  "Flight Director",
  "CAPCOM",
  "Booster Officer",
  "Guidance Officer",
  "Flight Dynamics",
  "Telemetry",
  "Payload Officer",
  "Retro Officer",
  "Recovery Lead",
  "Ground Crew",
] as const;
export type CardTitle = (typeof CARD_TITLES)[number];

export type AvatarMediaType = "image/jpeg" | "image/png" | "image/webp";

export interface ApprovedXAvatarSnapshot {
  readonly kind: "approved-x-avatar";
  readonly mediaType: AvatarMediaType;
  readonly bytesBase64: string;
  readonly sha256: string;
}

export interface SeasonZeroCardDraft {
  readonly cardId: string;
  readonly callsign: string;
  readonly avatar: ApprovedXAvatarSnapshot;
  readonly crew: number;
  readonly title: CardTitle;
}

export interface SeasonZeroCardRecord {
  readonly schema: typeof SEASON_ZERO_CARD_SCHEMA;
  readonly version: typeof SEASON_ZERO_CARD_VERSION;
  readonly cardId: string;
  readonly callsign: string;
  readonly avatar: ApprovedXAvatarSnapshot;
  readonly crew: number;
  readonly title: CardTitle;
  readonly edition: CardEdition;
}

export interface ShareCardStats {
  readonly recruitHandles: readonly string[];
  readonly recruitTotal: number;
}

export function createShareCardStats(input: unknown): ShareCardStats {
  assertPlainObject(input, "share card stats");
  if (!z.number().int().nonnegative().safeParse(input.recruitTotal).success) {
    throw new CardInputError("recruitTotal must be a non-negative integer.");
  }
  const handles = z.array(z.unknown()).max(5).safeParse(input.recruitHandles);
  if (!handles.success) {
    throw new CardInputError("recruitHandles must contain no more than five X handles.");
  }
  const recruitHandles = handles.data.map((handle) => {
    const normalized = requireString(handle, "recruit handle", 16).replace(/^@+/, "");
    if (!z.string().regex(/^[A-Za-z0-9_]{1,15}$/).safeParse(normalized).success) {
      throw new CardInputError("recruit handles must be valid X handles.");
    }
    return normalized;
  });
  return Object.freeze({
    recruitHandles: Object.freeze(recruitHandles),
    recruitTotal: input.recruitTotal as number,
  });
}

const CARD_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const FORBIDDEN_RECORD_KEYS = new Set([
  "code",
  "profileurl",
  "profile_url",
  "providerurl",
  "provider_url",
  "accesstoken",
  "access_token",
]);

export class CardInputError extends Error {
  readonly name = "CardInputError";

  constructor(message: string) {
    super(message);
  }
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!z.record(z.string(), z.unknown()).safeParse(value).success) {
    throw new CardInputError(`${label} must be an object.`);
  }
}

function assertNoForbiddenKeys(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertNoForbiddenKeys);
    return;
  }
  if (typeof value !== "object" || value === null) return;

  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_RECORD_KEYS.has(key.toLowerCase())) {
      throw new CardInputError(`Card inputs cannot contain ${key}.`);
    }
    assertNoForbiddenKeys(nested);
  }
}

function requireString(value: unknown, label: string, maxLength: number): string {
  const text = z.string().safeParse(value);
  if (!text.success) throw new CardInputError(`${label} must be a string.`);
  const normalized = text.data.trim();
  if (!z.string().min(1).max(maxLength).regex(/^[^\u0000-\u001f\u007f]*$/).safeParse(normalized).success) {
    throw new CardInputError(`${label} must contain 1-${maxLength} printable characters.`);
  }
  return normalized;
}

function normalizeCallsign(value: unknown): string {
  const callsign = requireString(value, "callsign", 21).replace(/^@+/, "");
  if (!z.string().min(1).max(20).regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/).safeParse(callsign).success) {
    throw new CardInputError("callsign must be 1-20 letters, numbers, dots, dashes, or underscores.");
  }
  return callsign;
}

function normalizeAvatar(value: unknown): ApprovedXAvatarSnapshot {
  assertPlainObject(value, "avatar");
  if (value.kind !== "approved-x-avatar") {
    throw new CardInputError("avatar must be an approved X avatar snapshot.");
  }
  if (!z.enum(["image/jpeg", "image/png", "image/webp"]).safeParse(value.mediaType).success) {
    throw new CardInputError("avatar mediaType must be image/jpeg, image/png, or image/webp.");
  }
  if (!z.string().min(1).regex(BASE64_PATTERN).safeParse(value.bytesBase64).success) {
    throw new CardInputError("avatar bytesBase64 must be canonical base64.");
  }
  if (!z.string().regex(SHA256_PATTERN).safeParse(value.sha256).success) {
    throw new CardInputError("avatar sha256 must be a lowercase SHA-256 digest.");
  }

  const bytes = Buffer.from(value.bytesBase64 as string, "base64");
  if (bytes.length === 0 || bytes.length > 5_000_000) {
    throw new CardInputError("avatar snapshot must contain 1-5000000 bytes.");
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== value.sha256) {
    throw new CardInputError("avatar sha256 does not match the snapshotted bytes.");
  }

  return Object.freeze({
    kind: "approved-x-avatar",
    mediaType: value.mediaType as AvatarMediaType,
    bytesBase64: bytes.toString("base64"),
    sha256: digest,
  });
}

export function createApprovedXAvatarSnapshot(
  bytes: Uint8Array,
  mediaType: AvatarMediaType,
): ApprovedXAvatarSnapshot {
  const buffer = Buffer.from(bytes);
  return normalizeAvatar({
    kind: "approved-x-avatar",
    mediaType,
    bytesBase64: buffer.toString("base64"),
    sha256: createHash("sha256").update(buffer).digest("hex"),
  });
}

export function createSeasonZeroCardRecord(input: SeasonZeroCardDraft | unknown): SeasonZeroCardRecord {
  assertNoForbiddenKeys(input);
  assertPlainObject(input, "card input");

  const cardId = requireString(input.cardId, "cardId", 96);
  if (!z.string().regex(CARD_ID_PATTERN).safeParse(cardId).success) {
    throw new CardInputError("cardId must be a lowercase stable identifier.");
  }
  if (!z.number().int().min(1).max(999999).safeParse(input.crew).success) {
    throw new CardInputError("crew must be an integer from 1 through 999999.");
  }
  if (!z.enum(CARD_TITLES).safeParse(input.title).success) {
    throw new CardInputError("title is not an approved mission-control title.");
  }
  for (const field of ["style", "gold", "fleet"]) {
    if (field in input) throw new CardInputError(`Card inputs cannot contain ${field}.`);
  }
  if ("version" in input && input.version !== SEASON_ZERO_CARD_VERSION) {
    throw new CardInputError("Unsupported card version.");
  }
  const crew = input.crew as number;
  return Object.freeze({
    schema: SEASON_ZERO_CARD_SCHEMA,
    version: SEASON_ZERO_CARD_VERSION,
    cardId,
    callsign: normalizeCallsign(input.callsign),
    avatar: normalizeAvatar(input.avatar),
    crew,
    title: input.title as CardTitle,
    edition: cardEditionForCrew(crew),
  });
}

export function serializeSeasonZeroCardRecord(record: SeasonZeroCardRecord): string {
  const validated = createSeasonZeroCardRecord(record);
  return JSON.stringify(validated);
}
