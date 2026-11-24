import { originalXAvatar } from "@blast/server/lib/x-avatar.ts";
import {
  createSeasonZeroCardRecord,
  type ApprovedXAvatarSnapshot,
  type SeasonZeroCardRecord,
} from "@blast/core/modules/mission-control/card-renderer/contract.ts";

async function dimensions(avatar: ApprovedXAvatarSnapshot) {
  const { default: sharp } = await import("sharp");
  const metadata = await sharp(Buffer.from(avatar.bytesBase64, "base64"), {
    limitInputPixels: 16_000_000,
  }).metadata();
  return { width: metadata.width ?? 0, height: metadata.height ?? 0 };
}

/**
 * Recover legacy thumbnails only on a cache miss. The trusted reference is the
 * photo saved with the connected X identity, never a callsign lookup. Only the
 * rendered derivative changes; the claimed card's identity stays immutable.
 */
export async function upgradeCardAvatar(
  record: SeasonZeroCardRecord,
  resolveReference: (cardId: string) => Promise<string | null>,
  fetcher: typeof fetch = fetch,
): Promise<SeasonZeroCardRecord> {
  const stored = await dimensions(record.avatar);
  if (stored.width >= 400 && stored.height >= 400) return record;
  const reference = await resolveReference(record.cardId);
  if (!reference) return record;
  const avatar = await originalXAvatar(reference, fetcher);
  if (!avatar) return record;
  const original = await dimensions(avatar);
  if (Math.min(original.width, original.height) <= Math.min(stored.width, stored.height)) {
    return record;
  }
  return createSeasonZeroCardRecord({ ...record, avatar });
}
