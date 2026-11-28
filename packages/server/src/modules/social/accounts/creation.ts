import { randomUUID } from "node:crypto";

import { DatabaseError } from "pg";

import type { LinkedXAccount } from "@blast/server/lib/privy-adapter/adapter.ts";
import type { ModuleTransaction, ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import {
  isSocialCallsign,
  normalizeSocialDisplayName,
  SOCIAL_DISPLAY_NAME_MAX_CODE_POINTS,
  type SocialAccountField,
  type SocialCallsignUnavailableReason,
} from "@blast/core/modules/social/contracts/accounts.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";

/** `findBlockedTerm` (config/reader.ts): the blocked term a text contains, or null. */
export type BlockedTermFinder = (text: string) => Promise<string | null>;

const CALLSIGN_HOLDERS = `
  SELECT
    EXISTS (SELECT 1 FROM mission_control_reserved_callsigns WHERE callsign = $1)
      OR EXISTS (SELECT 1 FROM social_referral_reservations WHERE code = $1) AS reserved,
    EXISTS (SELECT 1 FROM mission_control_profiles WHERE callsign = $1)
      OR EXISTS (SELECT 1 FROM social_accounts WHERE callsign = $1 AND account_id IS DISTINCT FROM $2::uuid)
      OR EXISTS (SELECT 1 FROM social_callsign_aliases WHERE callsign = $1 AND account_id IS DISTINCT FROM $2::uuid) AS taken`;

/**
 * Why a lowercased callsign cannot be taken, or null when it is free. The
 * availability route and account creation both use it, in this order:
 * format (`invalid`), a blocked term (`blocked`), Mission Control's reserved
 * list (`reserved`), then a profile or account holding it (`taken`). Creation
 * still relies on the callsign triggers for a callsign taken after this read.
 */
export async function callsignUnavailableReason(
  db: ReadableDatabase,
  callsign: string,
  findBlockedTerm: BlockedTermFinder,
  accountId: string | null = null,
): Promise<SocialCallsignUnavailableReason | null> {
  if (!isSocialCallsign(callsign)) return "invalid";
  if ((await findBlockedTerm(callsign)) !== null) return "blocked";
  const { rows } = await db.read<{ reserved: boolean; taken: boolean }>(CALLSIGN_HOLDERS, [callsign, accountId]);
  if (rows[0]?.reserved) return "reserved";
  if (rows[0]?.taken) return "taken";
  return null;
}

/** The refusal for a reason creation found before writing. */
export function callsignRefusal(reason: SocialCallsignUnavailableReason): SocialRouteError {
  switch (reason) {
    case "invalid":
      return new SocialRouteError("invalid_callsign");
    case "blocked":
      return blockedTerm("callsign");
    case "reserved":
      return new SocialRouteError("callsign_reserved");
    case "taken":
      return new SocialRouteError("callsign_taken");
  }
}

export function blockedTerm(field: SocialAccountField): SocialRouteError {
  return new SocialRouteError("blocked_term", { extra: { field } });
}

/**
 * The refusal a failed insert means, or null for any other failure. The
 * callsign triggers (0054) raise `23505 social_accounts_callsign_taken` and
 * `23514 social_accounts_callsign_not_reserved`; the unique indexes raise
 * `social_accounts_callsign_key` for a concurrent insert of the same callsign
 * and `social_accounts_privy_did_key` for the caller's own concurrent create.
 */
export function insertRefusal(error: unknown): SocialRouteError | null {
  if (!(error instanceof DatabaseError)) return null;
  if (error.code === "23505") {
    if (error.constraint === "social_accounts_callsign_taken" || error.constraint === "social_accounts_callsign_key") {
      return new SocialRouteError("callsign_taken");
    }
    if (error.constraint === "social_accounts_privy_did_key" || error.constraint === "social_accounts_sui_address_key") {
      return new SocialRouteError("account_exists");
    }
  }
  if (error.code === "23514" && error.constraint === "social_accounts_callsign_not_reserved") {
    return new SocialRouteError("callsign_reserved");
  }
  return null;
}

/** A new account's sign-in identity: a Privy DID, or a wallet session's Sui address (OA-16). */
export type NewAccount = Readonly<{
  privyDid: string | null;
  referralCallsign?: string | null;
  /** A wallet-only account's Sui address (its sign-in identity); null for a Privy account. */
  suiAddress?: string | null;
  callsign: string;
  displayName: string;
  /** The caller's linked X account, or null without one or when Privy could not be read. */
  x: LinkedXAccount | null;
}>;

/**
 * Creates a new account in the caller's transaction, which must run at READ
 * COMMITTED (the callsign triggers refuse anything else). A linked X account
 * that is a Mission Control member's is `member_exists` and writes nothing.
 * The callsign is checked first so the common refusals need no write; the
 * triggers and unique indexes decide a race, mapped by `insertRefusal`.
 * Answers the new account id.
 */
export async function insertNewAccount(
  social: ModuleTransaction<"social">,
  account: NewAccount,
  options: Readonly<{ findBlockedTerm: BlockedTermFinder; createId?: () => string }>,
): Promise<string> {
  const { x } = account;
  if (x) {
    const { rows } = await social.read<{ member: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM mission_control_profiles WHERE x_subject = $1) AS member",
      [x.xSubject],
    );
    if (rows[0]?.member) throw new SocialRouteError("member_exists");
  }
  const reason = await callsignUnavailableReason(social, account.callsign, options.findBlockedTerm);
  if (reason) throw callsignRefusal(reason);
  const accountId = (options.createId ?? randomUUID)();
  try {
    await social.write(
      "social_accounts",
      `INSERT INTO social_accounts (
         account_id, privy_did, sui_address, callsign, display_name, x_subject, x_handle, x_display_name, x_avatar_url, referrer_account_id, referrer_reservation_code
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
         (SELECT account_id FROM social_account_callsigns WHERE callsign = $10 AND account_id <> $1
           AND NOT EXISTS (SELECT 1 FROM social_referral_reservations WHERE code = $10)),
         (SELECT code FROM social_referral_reservations WHERE code = $10 AND x_subject IS DISTINCT FROM $6))`,
      [accountId, account.privyDid, account.suiAddress ?? null, account.callsign, account.displayName, x?.xSubject ?? null,
        x?.handle ?? null, x?.displayName ?? null, x?.avatarUrl ?? null, account.referralCallsign ?? null],
    );
  } catch (error) {
    throw insertRefusal(error) ?? error;
  }
  if (account.suiAddress) {
    // The signature that started the wallet session proved control of the
    // address: it is also the account's `slush` wallet (`me.wallets`, the
    // wallet view). An address another account holds would have signed into
    // that account instead.
    const linked = await social.write(
      "social_account_wallets",
      `INSERT INTO social_account_wallets (address, account_id, kind, verified_at)
       VALUES ($1, $2, 'slush', now())
       ON CONFLICT (address) DO NOTHING`,
      [account.suiAddress, accountId],
    );
    if (linked.rowCount !== 1) throw new SocialRouteError("account_exists");
  }
  return accountId;
}

/**
 * The display name a new account gets when onboarding sends none (OA-7: the
 * name comes from X, or is the callsign without X). The X name is cut to the
 * first 32 code points; an X name that trims to nothing or holds a blocked
 * term falls back to the callsign, which already passed the same checks.
 */
export async function derivedDisplayName(
  callsign: string,
  x: LinkedXAccount | null,
  findBlockedTerm: BlockedTermFinder,
): Promise<string> {
  const fromX = x?.displayName ? normalizeSocialDisplayName([...x.displayName.trim()].slice(0, SOCIAL_DISPLAY_NAME_MAX_CODE_POINTS).join("")) : null;
  if (fromX && (await findBlockedTerm(fromX)) === null) return fromX;
  return callsign;
}
