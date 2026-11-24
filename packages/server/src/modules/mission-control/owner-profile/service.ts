import { z } from "zod";
import type { Pool } from "pg";

import type { CardImageFormat, RenderedSeasonZeroCard, OwnerCardImages } from "@blast/core/modules/mission-control/card-images/render-port.ts";
import { CardImageBusyError } from "@blast/core/modules/mission-control/card-images/errors.ts";
import {
  autocommitReader,
  withTransaction,
  type ReadableDatabase,
} from "@blast/core/modules/database/transaction.ts";
import {
  OWNER_RECRUIT_PAGE_MAX,
  type DisplayNameDto,
  type OwnerProfileDto,
  type OwnerRecruitPageDto,
} from "@blast/core/modules/mission-control/owner-profile/contracts.ts";
import type { OwnerRecruitCursorCodec } from "@blast/server/modules/mission-control/owner-profile/cursor.server.ts";
import { OwnerProfileError } from "@blast/server/modules/mission-control/owner-profile/errors.ts";
import { OwnerProfileRepository } from "@blast/server/modules/mission-control/owner-profile/repository.ts";

export function normalizeOwnerDisplayName(value: unknown): string | null {
  if (value === null || value === "") return null;
  const parsed = z.string().safeParse(value);
  if (!parsed.success) throw new OwnerProfileError("DISPLAY_NAME_INVALID");
  const normalized = parsed.data.trim().replace(/\s+/gu, " ");
  if (!normalized) return null;
  if (!z.string().max(100).regex(/^[^\p{Cc}\p{Cf}]*$/u).safeParse(normalized).success) {
    throw new OwnerProfileError("DISPLAY_NAME_INVALID");
  }
  return normalized;
}

export class OwnerProfileService {
  readonly #cardImages: OwnerCardImages;
  readonly #cursor: OwnerRecruitCursorCodec;
  readonly #pool: Pool;
  /** Every owner read is one statement, sent without a transaction. */
  readonly #reads: ReadableDatabase;
  readonly #repository: OwnerProfileRepository;

  constructor(input: {
    cardImages: OwnerCardImages;
    cursor: OwnerRecruitCursorCodec;
    pool: Pool;
    repository?: OwnerProfileRepository;
  }) {
    this.#cardImages = input.cardImages;
    this.#cursor = input.cursor;
    this.#pool = input.pool;
    this.#reads = autocommitReader(input.pool, "profile");
    this.#repository = input.repository ?? new OwnerProfileRepository();
  }

  async getOwner(profileId: string): Promise<OwnerProfileDto> {
    const row = await this.#repository.summary(this.#reads, profileId);
    if (!row) throw new OwnerProfileError("OWNER_NOT_FOUND");
    return {
      callsignPath: row.callsign_path,
      profile: {
        avatarReference: row.avatar_reference,
        callsign: row.callsign,
        displayName: row.display_name,
        resolvedDisplayName: row.display_name ?? row.callsign,
      },
      social: {
        avatarReference: row.x_avatar_reference,
        handle: row.x_handle,
        verified: true,
      },
      wallet: {
        address: row.sui_address,
        kind: row.wallet_kind,
        state: "verified",
      },
      wallets: row.wallets.map((wallet) => ({
        id: wallet.wallet_id,
        address: wallet.sui_address,
        kind: wallet.wallet_kind,
        primary: wallet.is_primary,
        state: "verified" as const,
      })),
      membership: {
        crewNumber: Number(row.crew_number),
        fleet: row.fleet,
        fleetTitle: `${row.fleet} Fleet`,
        gold: row.gold,
        ownerTitle: row.owner_title,
        zeroFleet: row.zero_fleet,
      },
      card: { id: row.card_id },
      recruitTotal: row.recruit_total,
      codeTotal: row.code_total,
      rewards: {
        followedBlast: row.followed_blast,
        rewarded: row.social_rewarded,
        sharedOnX: row.shared_on_x,
        telegramUsername: row.telegram_username,
      },
    };
  }

  async getRecruits(
    profileId: string,
    cursorValue: string | null,
    requestedLimit: number,
  ): Promise<OwnerRecruitPageDto> {
    const limit = Math.min(OWNER_RECRUIT_PAGE_MAX, Math.max(1, requestedLimit));
    const cursor = cursorValue ? this.#cursor.decode(cursorValue) : null;
    if (cursorValue && !cursor) throw new OwnerProfileError("CURSOR_INVALID");
    const rows = await this.#repository.recruits(this.#reads, {
      cursor,
      limit,
      profileId,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        callsign: row.callsign,
        completedAt: row.completed_at.toISOString(),
        crewNumber: Number(row.crew_number),
        displayName: row.display_name,
        fleet: row.fleet,
        ownerTitle: row.owner_title,
        x: {
          avatarReference: row.x_avatar_reference,
          handle: row.x_handle,
        },
      })),
      nextCursor: rows.length > limit && last
        ? this.#cursor.encode({
            completedAt: last.completed_at.toISOString(),
            profileId: last.profile_id,
          })
        : null,
    };
  }

  async getCardImage(profileId: string, format: CardImageFormat = "card"): Promise<Readonly<{
    callsign: string;
    image: RenderedSeasonZeroCard;
  }>> {
    const row = await this.#repository.card(this.#reads, profileId);
    if (!row) throw new OwnerProfileError("OWNER_NOT_FOUND");
    try {
      return {
        callsign: row.callsign,
        image: await this.#cardImages.image({ format, record: row.card_record }),
      };
    } catch (error) {
      throw new OwnerProfileError(
        error instanceof CardImageBusyError ? "CARD_BUSY" : "CARD_UNAVAILABLE",
      );
    }
  }

  async updateDisplayName(profileId: string, value: unknown): Promise<DisplayNameDto> {
    const displayName = normalizeOwnerDisplayName(value);
    const updated = await withTransaction(this.#pool, (transaction) =>
      this.#repository.updateDisplayName(transaction, profileId, displayName),
    );
    if (!updated) throw new OwnerProfileError("OWNER_NOT_FOUND");
    return {
      callsign: updated.callsign,
      displayName: updated.displayName,
      resolvedDisplayName: updated.displayName ?? updated.callsign,
    };
  }
}
