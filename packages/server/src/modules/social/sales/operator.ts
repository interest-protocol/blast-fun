import { z } from "zod";
import { OperatorError } from "@blast/server/modules/mission-control/operator/errors.ts";
import type { LaunchAssetRemover } from "@blast/server/modules/launch-assets/store.ts";
import { SALE_METADATA_FIELDS } from "@blast/core/modules/social/contracts/sales.ts";
import { socialOperatorCommand, type SocialOperatorContext } from "../operator/framework.ts";
import { EMPTY_STORED_SALE_METADATA, readStoredSaleMetadata, sameStored, storedFromBefore, writeSaleMetadata, type SaleMetadataChange, type StoredSaleMetadata } from "@blast/server/modules/social/sales/store.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

/**
 * The operator's tools over a sale's public details (R3-24, OA-25 Q7 and
 * Q5), each one `social_operator_log` row and, when it changes anything, one
 * `social_sale_metadata_edits` row authored by the operator:
 *
 *   sale metadata history <presale_id>
 *   sale metadata clear <presale_id> --reason <text>
 *   sale metadata revert <presale_id> <edit_id> --reason <text>
 *   sale metadata launch-at <presale_id> <ISO-8601 time|none> --reason <text>
 *
 * No value a creator wrote is printed or logged: the history and the log
 * name the fields that changed and the edits, never their text (AC-130).
 * A cover an operator removes is named in the result (`removed_cover_url`)
 * so the CLI deletes its object once the change is committed.
 */

/** A row's value fields, by name, as a change lists them. */
const VALUE_FIELDS = [...SALE_METADATA_FIELDS, "launch_at_ms", "cover"] as const;
type ValueField = (typeof VALUE_FIELDS)[number];

/** The cover as a change compares it: its object and its upload's size (0137), which a re-upload of the same pixels can add. */
function coverIdentity(cover: StoredSaleMetadata["cover"]): string | null {
  return cover ? `${cover.key}|${cover.source ? `${cover.source.width}x${cover.source.height}` : ""}` : null;
}

/** The fields that differ between two stored values. */
export function changedFields(a: StoredSaleMetadata, b: StoredSaleMetadata): ValueField[] {
  return VALUE_FIELDS.filter((field) =>
    field === "cover" ? coverIdentity(a.cover) !== coverIdentity(b.cover) : a[field] !== b[field]);
}

function presaleIdOf(value: string | undefined): string | null {
  const parsed = z.string().regex(SUI_OBJECT_ID_PATTERN).safeParse(value);
  return parsed.success ? parsed.data : null;
}

const author = (context: SocialOperatorContext) => ({ operatorId: context.operator.operatorId });

/** The cover a change removed, when its object is the sale's alone to delete. */
function removedCover(before: StoredSaleMetadata, stored: StoredSaleMetadata): string | null {
  return before.cover && before.cover.key !== stored.cover?.key ? before.cover.url : null;
}

type EditRow = { edit_id: string; account_id: string | null; operator_id: string | null; at_ms: string; before: unknown };

const EDITS_SQL = `SELECT edit_id::text, account_id::text, operator_id, at_ms::text, before
  FROM social_sale_metadata_edits WHERE presale_id = $1 ORDER BY edit_id DESC LIMIT $2`;

const history = socialOperatorCommand<{ presaleId: string }>({
  path: ["sale", "metadata", "history"],
  usage: "sale metadata history <presale_id>   (the latest 50 edits: who, when and which fields, never their text)",
  parse: (args) => {
    const presaleId = args.length === 1 ? presaleIdOf(args[0]) : null;
    return presaleId ? { presaleId } : null;
  },
  run: async ({ presaleId }, { transaction }) => {
    const [{ rows }, metadata] = await Promise.all([transaction.read<EditRow>(EDITS_SQL, [presaleId, 50]), readStoredSaleMetadata(transaction, presaleId)]);
    let after = metadata;
    const edits = rows.map((row) => {
      const before = storedFromBefore(row.before) ?? EMPTY_STORED_SALE_METADATA;
      const entry = {
        editId: row.edit_id,
        at: new Date(Number(row.at_ms)).toISOString(),
        by: row.operator_id ? { operator: row.operator_id } : { account: row.account_id },
        changed: changedFields(before, after),
      };
      after = before;
      return entry;
    });
    return {
      result: { presaleId, edits },
      log: { action: "sale.metadata.history", target: presaleId, before: null, after: null },
    };
  },
});

const clear = socialOperatorCommand<{ presaleId: string }>({
  path: ["sale", "metadata", "clear"],
  // A change someone must account for: refused without a `--reason` before anything runs (R3-23's rule).
  reasonRequired: true,
  usage: "sale metadata clear <presale_id> --reason <text>   (removes the tagline, links and cover; the launch date stays)",
  parse: (args) => {
    const presaleId = args.length === 1 ? presaleIdOf(args[0]) : null;
    return presaleId ? { presaleId } : null;
  },
  run: async ({ presaleId }, context) => {
    const change: SaleMetadataChange = { ...Object.fromEntries(SALE_METADATA_FIELDS.map((field) => [field, null])), cover: null };
    const written = await writeSaleMetadata(context.transaction, presaleId, change, author(context));
    const changed = changedFields(written.before, written.stored);
    return {
      result: { presaleId, editId: written.editId, changed, removed_cover_url: removedCover(written.before, written.stored) },
      log: { action: "sale.metadata.clear", target: presaleId, before: { edit_id: written.editId, changed }, after: null },
    };
  },
});

const revert = socialOperatorCommand<{ presaleId: string; editId: string }>({
  path: ["sale", "metadata", "revert"],
  // A change someone must account for: refused without a `--reason` before anything runs (R3-23's rule).
  reasonRequired: true,
  usage: "sale metadata revert <presale_id> <edit_id> --reason <text>   (puts back what that edit changed; a cover it replaced is gone, so its cover is removed)",
  parse: (args) => {
    const presaleId = args.length === 2 ? presaleIdOf(args[0]) : null;
    const editId = z.string().regex(/^[1-9][0-9]{0,17}$/).safeParse(args[1]).success ? args[1] : null;
    return presaleId && editId ? { presaleId, editId } : null;
  },
  run: async ({ presaleId, editId }, context) => {
    const { transaction } = context;
    await transaction.read("SELECT pg_advisory_xact_lock(hashtext('social_sale_metadata'), hashtext($1))", [presaleId]);
    const { rows } = await transaction.read<{ before: unknown; next_before: unknown }>(
      `SELECT e.before,
         (SELECT n.before FROM social_sale_metadata_edits n WHERE n.presale_id = e.presale_id AND n.edit_id > e.edit_id
          ORDER BY n.edit_id LIMIT 1) AS next_before
       FROM social_sale_metadata_edits e WHERE e.presale_id = $1 AND e.edit_id = $2::bigint`,
      [presaleId, editId],
    );
    const row = rows[0];
    const before = row ? storedFromBefore(row.before) : null;
    if (!row || !before) throw new OperatorError("OPERATOR_INPUT_INVALID");
    const current = await readStoredSaleMetadata(transaction, presaleId);
    // What the edit left: the next edit's `before`, or the row when it is the latest.
    const after = row.next_before === null ? current : storedFromBefore(row.next_before) ?? current;
    const change: Record<string, unknown> = {};
    for (const field of changedFields(before, after)) {
      // A replaced cover's object was deleted when it was replaced: reverting removes the cover the edit set.
      change[field] = field === "cover" ? (before.cover && before.cover.key === current.cover?.key ? current.cover : null) : before[field];
    }
    const written = await writeSaleMetadata(transaction, presaleId, change as SaleMetadataChange, author(context));
    const changed = sameStored(written.before, written.stored) ? [] : changedFields(written.before, written.stored);
    return {
      result: { presaleId, revertedEditId: editId, editId: written.editId, changed, removed_cover_url: removedCover(written.before, written.stored) },
      log: { action: "sale.metadata.revert", target: presaleId, before: { edit_id: written.editId, reverted_edit_id: editId, changed }, after: null },
    };
  },
});

const launchAt = socialOperatorCommand<{ presaleId: string; launchAtMs: number | null }>({
  path: ["sale", "metadata", "launch-at"],
  // A change someone must account for: refused without a `--reason` before anything runs (R3-23's rule).
  reasonRequired: true,
  usage: "sale metadata launch-at <presale_id> <ISO-8601 time with its zone, or none> --reason <text>   (OA-25 Q5: the published launch date)",
  parse: (args) => {
    const presaleId = args.length === 2 ? presaleIdOf(args[0]) : null;
    if (!presaleId) return null;
    if (args[1] === "none") return { presaleId, launchAtMs: null };
    const parsed = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/)
      .transform((value) => Date.parse(value)).pipe(z.number().int().positive()).safeParse(args[1]);
    return parsed.success ? { presaleId, launchAtMs: parsed.data } : null;
  },
  run: async ({ presaleId, launchAtMs }, context) => {
    const written = await writeSaleMetadata(context.transaction, presaleId, { launch_at_ms: launchAtMs }, author(context));
    return {
      result: { presaleId, editId: written.editId, launchAtMs: written.stored.launch_at_ms },
      log: {
        action: "sale.metadata.launch_at",
        target: presaleId,
        before: { edit_id: written.editId, launch_at_ms: written.before.launch_at_ms },
        after: { launch_at_ms: written.stored.launch_at_ms },
      },
    };
  },
});

export const SALE_METADATA_OPERATOR_COMMANDS = Object.freeze([history, clear, revert, launchAt]);

/**
 * After a committed `clear` or `revert`, deletes the cover object it removed
 * (`removed_cover_url` in the result). Without a store, or when the delete
 * fails, the object stays and the answer says so; the row no longer names it.
 */
export async function removeOperatorCover(result: unknown, store: LaunchAssetRemover | null): Promise<"removed" | "kept" | "none"> {
  const url = result && typeof result === "object" ? (result as { removed_cover_url?: unknown }).removed_cover_url : null;
  if (typeof url !== "string") return "none";
  if (!store) return "kept";
  try {
    await store.remove(url);
    return "removed";
  } catch {
    return "kept";
  }
}
