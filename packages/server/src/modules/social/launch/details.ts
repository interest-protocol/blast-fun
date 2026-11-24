import { primaryPool } from "@blast/core/modules/database/pool.ts";
import {
  parseLaunchDetails,
  type LaunchPageDetails,
} from "@blast/core/modules/launchpad-coin/transfer.ts";
import {
  autocommitReader,
  type ReadableDatabase,
} from "@blast/core/modules/database/transaction.ts";
import { z } from "zod";
import { LAUNCH_HANDLE_MAX, LAUNCH_LINK_MAX } from "@blast/core/modules/social/launch/model.ts";
import { normalizeSaleLink, normalizeTelegram, normalizeXHandle } from "@blast/core/modules/social/sales/validate.ts";

/** Public projection of a confirmed publication; drafts and account identities never leave this read. */
export async function readLaunchDetails(
  launchId: string,
  database?: ReadableDatabase,
): Promise<LaunchPageDetails | null> {
  const db =
    database ??
    autocommitReader(primaryPool(), "social", {
      label: "social.launch_details",
    });
  const { rows } = await db.read<{
    body: unknown;
    logo_url: string | null;
    cover_url: string | null;
    cover_width: number | null;
    cover_height: number | null;
  }>(
    `SELECT body, logo_url, cover_url, cover_width, cover_height FROM social_launch_drafts WHERE published_launch_id = $1`,
    [launchId],
  );
  const row = rows[0];
  if (!row) return null;
  let draft;
  try {
    // Public presentation does not depend on the draft's economic schema version.
    draft = z.object({
      tagline: z.string().max(160),
      site: z.string().max(LAUNCH_LINK_MAX),
      docs_url: z.string().max(LAUNCH_LINK_MAX),
      audit_url: z.string().max(LAUNCH_LINK_MAX),
      x_handle: z.string().max(LAUNCH_HANDLE_MAX),
      telegram: z.string().max(LAUNCH_HANDLE_MAX),
    }).parse(row.body);
  } catch {
    return null;
  }
  const links: { label: string; url: string }[] = [];
  for (const [label, raw] of [["Website", draft.site], ["Docs", draft.docs_url], ["Audit", draft.audit_url]] as const) {
    const result = normalizeSaleLink(raw);
    if (result.ok && result.value) links.push({ label, url: result.value });
  }
  const x = normalizeXHandle(draft.x_handle);
  if (x.ok && x.value) links.push({ label: "X", url: `https://x.com/${x.value}` });
  const telegram = normalizeTelegram(draft.telegram);
  if (telegram.ok && telegram.value)
    links.push({ label: "Telegram", url: `https://t.me/${telegram.value}` });
  const details = {
    tagline: draft.tagline,
    ...(row.logo_url?.startsWith("https://") ? { iconUrl: row.logo_url } : {}),
    links,
    cover:
      row.cover_url && row.cover_width && row.cover_height
        ? {
            url: row.cover_url,
            width: row.cover_width,
            height: row.cover_height,
          }
        : null,
  };
  try {
    return parseLaunchDetails(details);
  } catch {
    return null;
  }
}
