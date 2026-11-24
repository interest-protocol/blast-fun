import { timed } from "@blast/core/lib/metrics.ts";
import type { ModuleTransaction, ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { SocialPrivacy } from "@blast/core/modules/social/contracts/me.ts";
import {
  socialSettingsRequestSchema,
  SOCIAL_SETTINGS_READ_ROUTE,
  SOCIAL_SETTINGS_ROUTE,
  type NotificationPreferences,
  type SocialExplorer,
  type SocialSettingsResponse,
} from "@blast/core/modules/social/contracts/settings.ts";
import {
  readAccountNotificationPreferences,
  writeNotificationPreferences,
} from "@blast/server/modules/social/notification-preferences/index.ts";
import { readSocialJsonWithSchema, type SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";

type SettingsRow = {
  privacy: SocialPrivacy;
  sharing_since_ms: string | null;
  commit_too_coin_type: string | null;
  portfolio_public: boolean;
  explorer: SocialExplorer;
  /** Null while the account has never chosen (0099). */
  sound: boolean | null;
  blast_mode_confirm_actions: boolean;
};

const SETTINGS_COLUMNS = `
    a.privacy,
    floor(extract(epoch FROM a.sharing_since) * 1000)::bigint AS sharing_since_ms,
    a.commit_too_coin_type,
    a.portfolio_public,
    a.explorer,
    a.sound,
    a.blast_mode_confirm_actions`;

/**
 * One statement, so the row lock decides against the account's current
 * privacy. `$2` is `private`, `$3` `public_portfolio`, `$4` the explorer,
 * `$5` the sound switch, `$6` the Blast mode confirmation (each null:
 * unchanged; so a sound choice, once made, is never reset to "no choice").
 * `$7` says whether the hold's pay coin changes, to `$8` (null is
 * each sale's own coin). Going public
 * starts sharing at the server's time when private or not yet sharing; on a
 * public account `sharing_since` never moves, so earlier public actions stay
 * named.
 * In `SET`,
 * `a.*` are the old values; `RETURNING` gives the new ones.
 */
const UPDATE_SETTINGS = `
  UPDATE social_accounts AS a SET
    privacy = CASE WHEN $2::boolean IS NULL THEN a.privacy WHEN $2::boolean THEN 'private' ELSE 'public' END,
    sharing_since = CASE
      WHEN $2::boolean IS NULL THEN a.sharing_since
      WHEN $2::boolean THEN NULL
      WHEN a.privacy = 'private' OR a.sharing_since IS NULL THEN now()
      ELSE a.sharing_since
    END,
    portfolio_public = COALESCE($3::boolean, a.portfolio_public),
    explorer = COALESCE($4::text, a.explorer),
    sound = COALESCE($5::boolean, a.sound),
    blast_mode_confirm_actions = COALESCE($6::boolean, a.blast_mode_confirm_actions),
    commit_too_coin_type = CASE WHEN $7::boolean THEN $8::text ELSE a.commit_too_coin_type END
  WHERE a.account_id = $1
  RETURNING ${SETTINGS_COLUMNS}`;

const READ_SETTINGS = `SELECT ${SETTINGS_COLUMNS} FROM social_accounts a WHERE a.account_id = $1`;

function settingsOf(row: SettingsRow, notifications: NotificationPreferences): SocialSettingsResponse {
  return {
    privacy: row.privacy,
    sharing_since_ms: row.sharing_since_ms === null ? null : Number(row.sharing_since_ms),
    commit_too_coin_type: row.commit_too_coin_type,
    public_portfolio: row.portfolio_public === true,
    explorer: row.explorer,
    sound: row.sound === null ? null : row.sound === true,
    blast_mode_confirm_actions: row.blast_mode_confirm_actions === true,
    notifications,
  };
}

async function readSettings(db: ReadableDatabase, accountId: string): Promise<SocialSettingsResponse> {
  const [result, notifications] = await Promise.all([
    db.read<SettingsRow>(READ_SETTINGS, [accountId]),
    readAccountNotificationPreferences(db, accountId),
  ]);
  const row = result.rows[0];
  if (!row) throw new Error("The settings read matched no account.");
  return settingsOf(row, notifications);
}

export type SocialSettingsRouteDependencies = Readonly<{
  kit: SocialRouteKit;
  /**
   * Standalone reads for `GET` (the primary in production, so a change is
   * read back at once). Without it the read runs in a kit transaction.
   */
  database?: () => ReadableDatabase;
}>;

/**
 * `GET` and `PUT /api/social/me/settings` (contract in
 * `contracts/settings.ts`), on the primary. Naming follows at read time (the
 * read model reads `privacy` and `sharing_since`; the public portfolio read
 * reads `portfolio_public`); this route purges no cache, so a public
 * portfolio may stay in shared caches for up to 30 s after it is switched
 * off.
 *
 * `PUT` order: kit (auth, `social_account_update`, account required), closed
 * body (`invalid_request`), then one transaction:
 * the account's row, then the
 * notification switches.
 */
export function createSocialSettingsRoute(dependencies: SocialSettingsRouteDependencies) {
  const { kit, database } = dependencies;
  return Object.freeze({
    GET: kit.route(
      { name: SOCIAL_SETTINGS_READ_ROUTE, auth: "account", account: "required", bucket: "social_me_read", cache: "private" },
      async (context) => {
        const accountId = context.account!.account_id;
        const settings = await timed("social.settings", () =>
          database
            ? readSettings(database(), accountId)
            : context.transaction((social) => readSettings(social, accountId), { label: "social.settings_read" }),
        { operation: "read" }, { sampleRate: 0.1 });
        return context.json(settings);
      },
    ),
    PUT: kit.route(
      { name: SOCIAL_SETTINGS_ROUTE, auth: "account", account: "required", bucket: "social_account_update", cache: "private" },
      async (context) => {
        const body = await readSocialJsonWithSchema(context.request, socialSettingsRequestSchema);
        const notifications = body.notifications ?? null;
        const accountId = context.account!.account_id;
        const changesAccount =
          body.private !== undefined ||
          body.public_portfolio !== undefined ||
          body.commit_too_coin_type !== undefined ||
          body.explorer !== undefined ||
          body.sound !== undefined ||
          body.blast_mode_confirm_actions !== undefined;

        const settings = await timed("social.settings", () =>
          context.transaction(
            async (social: ModuleTransaction<"social">) => {
              let row: SettingsRow | undefined;
              if (changesAccount) {
                const result = await social.write<SettingsRow>("social_accounts", UPDATE_SETTINGS, [
                  accountId,
                  body.private ?? null,
                  body.public_portfolio ?? null,
                  body.explorer ?? null,
                  body.sound ?? null,
                  body.blast_mode_confirm_actions ?? null,
                  body.commit_too_coin_type !== undefined,
                  body.commit_too_coin_type ?? null,
                ]);
                row = result.rows[0];
              } else {
                row = (await social.read<SettingsRow>(READ_SETTINGS, [accountId])).rows[0];
              }
              if (!row) throw new Error("The settings update matched no account.");
              const switches =
                notifications && Object.keys(notifications).length > 0
                  ? await writeNotificationPreferences(social, accountId, notifications)
                  : await readAccountNotificationPreferences(social, accountId);
              return settingsOf(row, switches);
            },
            { label: "social.settings" },
          ),
        { operation: "write", fields: [
          body.private !== undefined && "private",
          body.public_portfolio !== undefined && "public_portfolio",
          body.commit_too_coin_type !== undefined && "coin",
          body.explorer !== undefined && "explorer",
          body.sound !== undefined && "sound",
          body.blast_mode_confirm_actions !== undefined && "blast_mode_confirm_actions",
          notifications && "notifications",
        ].filter(Boolean).join(",") || "none" });
        return context.json(settings);
      },
    ),
  });
}
