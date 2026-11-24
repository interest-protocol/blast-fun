import { z } from "zod";

import type { ModuleTransaction, ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_PREFERENCE_KEYS,
  type NotificationPreferenceKey,
  type NotificationPreferences,
} from "@blast/core/modules/social/contracts/settings.ts";

/**
 * The eight notification switches (owner decision OA-11) as the notification
 * system reads them. Each key is a column of `social_notification_preferences`
 * (migration 0059); an account without a row has every switch on.
 *
 * Reads take any `ReadableDatabase`: the web runtime's primary, or the
 * watcher's pool when it sends notifications (`blast_watcher` may read the
 * table). They never return a Privy DID or anything else of the account.
 */

const COLUMNS = NOTIFICATION_PREFERENCE_KEYS.join(", ");
const DEFAULTED = NOTIFICATION_PREFERENCE_KEYS.map((key) => `COALESCE(p.${key}, true) AS ${key}`).join(", ");

type PreferenceRow = Readonly<Record<NotificationPreferenceKey, boolean>> & { account_id: string };

function preferencesOf(row: Readonly<Record<NotificationPreferenceKey, boolean>>): NotificationPreferences {
  return Object.fromEntries(NOTIFICATION_PREFERENCE_KEYS.map((key) => [key, row[key] === true])) as NotificationPreferences;
}

/** Whether `key` names one of the eight switches. */
export const notificationPreferenceKeySchema = z.enum(NOTIFICATION_PREFERENCE_KEYS);

export function isNotificationPreferenceKey(value: unknown): value is NotificationPreferenceKey {
  return notificationPreferenceKeySchema.safeParse(value).success;
}

/**
 * The switches of each account in `accountIds` (one statement, primary-key
 * lookups). An account id with no row reads every switch on; an id that is
 * not an account still gets the defaults, so a caller filters to accounts it
 * knows.
 */
export async function readNotificationPreferences(
  db: ReadableDatabase,
  accountIds: readonly string[],
): Promise<Map<string, NotificationPreferences>> {
  const ids = [...new Set(accountIds)];
  if (ids.length === 0) return new Map();
  const result = await db.read<PreferenceRow>(
    `SELECT ids.account_id::text AS account_id, ${DEFAULTED}
     FROM unnest($1::uuid[]) AS ids (account_id)
     LEFT JOIN social_notification_preferences p ON p.account_id = ids.account_id`,
    [ids],
  );
  return new Map(result.rows.map((row) => [row.account_id, preferencesOf(row)]));
}

/** One account's switches (every switch on until it changes one). */
export async function readAccountNotificationPreferences(
  db: ReadableDatabase,
  accountId: string,
): Promise<NotificationPreferences> {
  return (await readNotificationPreferences(db, [accountId])).get(accountId) ?? DEFAULT_NOTIFICATION_PREFERENCES;
}

/**
 * The accounts among `accountIds` that want notifications of kind `key`, in
 * the order given. The notification generator calls this with a batch of
 * recipients (one statement per batch, no N+1).
 */
export async function accountsWantingNotification(
  db: ReadableDatabase,
  key: NotificationPreferenceKey,
  accountIds: readonly string[],
): Promise<string[]> {
  if (!isNotificationPreferenceKey(key)) throw new TypeError(`Unknown notification preference ${String(key)}.`);
  const wanted = await readNotificationPreferences(db, accountIds);
  return accountIds.filter((id, index) => accountIds.indexOf(id) === index && wanted.get(id)?.[key] === true);
}

/**
 * Sets the switches named in `changes` for `accountId` (the others keep their
 * value, or the default on a first change) and returns all eight. One
 * statement inside the caller's transaction; repeating it gives the same
 * switches (only `updated_at` moves).
 */
export async function writeNotificationPreferences(
  social: ModuleTransaction<"social">,
  accountId: string,
  changes: Partial<NotificationPreferences>,
): Promise<NotificationPreferences> {
  const values = NOTIFICATION_PREFERENCE_KEYS.map((key) => (typeof changes[key] === "boolean" ? changes[key] : null));
  const inserted = NOTIFICATION_PREFERENCE_KEYS.map((_, index) => `COALESCE($${index + 2}::boolean, true)`).join(", ");
  const updated = NOTIFICATION_PREFERENCE_KEYS.map(
    (key, index) => `${key} = COALESCE($${index + 2}::boolean, social_notification_preferences.${key})`,
  ).join(", ");
  const result = await social.write<PreferenceRow>(
    "social_notification_preferences",
    `INSERT INTO social_notification_preferences (account_id, ${COLUMNS})
     VALUES ($1, ${inserted})
     ON CONFLICT (account_id) DO UPDATE SET ${updated}, updated_at = now()
     RETURNING account_id::text AS account_id, ${COLUMNS}`,
    [accountId, ...values],
  );
  const row = result.rows[0];
  if (!row) throw new Error("The notification preferences upsert returned no row.");
  return preferencesOf(row);
}
