import { z } from "zod";
import { normalizeSuiAddress } from "@mysten/sui/utils";

import { recordMetric, timed } from "@blast/core/lib/metrics.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { BlockedTermFinder } from "@blast/server/modules/social/accounts/creation.ts";
import {
  SALE_METADATA_FIELDS,
  SOCIAL_SALE_COVER_DELETE_ROUTE,
  SOCIAL_SALE_COVER_UPLOAD_ROUTE,
  SOCIAL_SALE_METADATA_READ_ROUTE,
  SOCIAL_SALE_METADATA_ROUTE,
  type SocialSaleMetadataResponse,
} from "@blast/core/modules/social/contracts/sales.ts";
import { readAccountAddresses } from "@blast/server/modules/social/accounts/read-wallet-addresses.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { readSocialJson, type SocialRequestContext, type SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { sanitizeSquareImage } from "@blast/server/modules/social/square-image.ts";
import { SALE_COVER_IMAGE, readCoverUpload, saleCoverFolder, storeCover, type SaleCoverStore } from "@blast/server/modules/social/sales/cover.ts";
import type { SaleEditorSource } from "@blast/server/modules/social/sales/editor.ts";
import {
  publicSaleMetadata,
  readShownSaleLifecycle,
  readStoredSaleMetadata,
  writeSaleMetadata,
  type SaleMetadataChange,
  type StoredSaleMetadata,
} from "@blast/server/modules/social/sales/store.ts";
import { normalizeSaleMetadata } from "@blast/core/modules/social/sales/validate.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";
import { routeSegments } from "@blast/core/modules/backend-api/route-path.ts";
import { SOCIAL_SALE_COVER_PATH, SOCIAL_SALE_METADATA_PATH } from "@blast/core/modules/backend-api/private/social-sales-contracts.ts";

export type SocialSaleRoutesDependencies = Readonly<{
  kit: SocialRouteKit;
  findBlockedTerm: BlockedTermFinder;
  /** The wallet allowed to edit a sale (its `PresaleCap`'s holder), or null. */
  editor: SaleEditorSource;
  /** The public cover store, or null when uploads are off (`LAUNCH_ASSET_BLOB_READ_WRITE_TOKEN` unset). Resolved per request. */
  store: () => SaleCoverStore | null;
  /** Reads on the primary outside a transaction; without it reads run in a kit transaction. */
  database?: () => ReadableDatabase;
}>;

type Context = SocialRequestContext;

/** The sale id in `/api/social/sales/{presale_id}/…`: malformed is `invalid_parameter` (`presale_id`). */
export function saleIdParameter(request: Request): string {
  const pathname = new URL(request.url).pathname;
  const id = (routeSegments(SOCIAL_SALE_METADATA_PATH, pathname) ?? routeSegments(SOCIAL_SALE_COVER_PATH, pathname))?.presale_id ?? "";
  if (!z.string().regex(SUI_OBJECT_ID_PATTERN).safeParse(id).success) throw new SocialRouteError("invalid_parameter", { extra: { parameter: "presale_id" } });
  return id;
}

/**
 * The sale details routes (contract in `contracts/sales.ts`), every answer
 * `private, no-store`. A write checks, in order: the body's shape
 * (`invalid_request`), the sale (`not_found`), the caller's ownership
 * (`not_sale_creator`), the sale's state (`sale_cancelled`), then the fields
 * and blocked terms, so only the creator learns why a value was refused.
 *
 * Metrics: `social.sale_metadata` with `operation` and `outcome` only; no
 * value, sale id, address or account reaches a metric or a log line (AC-130).
 */
export function createSocialSaleRoutes(dependencies: SocialSaleRoutesDependencies) {
  const { kit, findBlockedTerm, editor, store, database } = dependencies;
  const account = { auth: "account", account: "required", cache: "private" } as const;

  function read<Result>(context: Context, label: string, operation: (db: ReadableDatabase) => Promise<Result>): Promise<Result> {
    return database ? operation(database()) : context.transaction((social) => operation(social), { label });
  }

  /** Whether one of the account's wallets holds the sale's cap. */
  async function owns(db: ReadableDatabase, accountId: string, presaleId: string): Promise<boolean> {
    const holder = await editor(presaleId);
    if (!holder) return false;
    const wallet = normalizeSuiAddress(holder);
    return (await readAccountAddresses(db, accountId)).some((address) => normalizeSuiAddress(address) === wallet);
  }

  /** A write's sale checks: shown (404), the caller's (403), not cancelled (409). */
  async function editable(context: Context, presaleId: string): Promise<void> {
    const accountId = context.account!.account_id;
    await read(context, "social.sale_metadata_read", async (db) => {
      const lifecycle = await readShownSaleLifecycle(db, presaleId);
      if (lifecycle === null) throw new SocialRouteError("not_found");
      if (!(await owns(db, accountId, presaleId))) throw new SocialRouteError("not_sale_creator");
      if (lifecycle === "cancelled") throw new SocialRouteError("sale_cancelled");
    });
  }

  const answer = (presaleId: string, stored: StoredSaleMetadata, editableNow: boolean): SocialSaleMetadataResponse => ({
    presale_id: presaleId,
    metadata: publicSaleMetadata(stored),
    editable: editableNow,
  });

  /** After the row names the new cover (or none), the replaced object goes; a failure is counted, never the caller's. */
  async function removeReplaced(before: StoredSaleMetadata, stored: StoredSaleMetadata): Promise<void> {
    if (!before.cover || before.cover.key === stored.cover?.key) return;
    const target = store();
    if (!target) {
      recordMetric("social.sale_metadata", { operation: "cover_remove", outcome: "no_store" });
      return;
    }
    try {
      await target.remove(before.cover.url);
    } catch {
      recordMetric("social.sale_metadata", { operation: "cover_remove", outcome: "failed" });
    }
  }

  return Object.freeze({
    metadata: Object.freeze({
      GET: kit.route({ ...account, name: SOCIAL_SALE_METADATA_READ_ROUTE, bucket: "social_read" }, async (context) => {
        const presaleId = saleIdParameter(context.request);
        const accountId = context.account!.account_id;
        const body = await timed("social.sale_metadata", () =>
          read(context, "social.sale_metadata_read", async (db) => {
            const lifecycle = await readShownSaleLifecycle(db, presaleId);
            if (lifecycle === null) throw new SocialRouteError("not_found");
            const stored = await readStoredSaleMetadata(db, presaleId);
            let mine = false;
            if (lifecycle !== "cancelled") {
              try {
                mine = await owns(db, accountId, presaleId);
              } catch {
                // The fullnode is down: the page offers no editing rather than failing.
                recordMetric("social.sale_metadata", { operation: "read", outcome: "editor_unavailable" });
              }
            }
            return answer(presaleId, stored, mine);
          }),
        { operation: "read" }, { sampleRate: 0.1 });
        return context.json(body);
      }),

      PUT: kit.route({ ...account, name: SOCIAL_SALE_METADATA_ROUTE, bucket: "social_account_update" }, async (context) => {
        const presaleId = saleIdParameter(context.request);
        const body = await readSocialJson(context.request, [], SALE_METADATA_FIELDS);
        await editable(context, presaleId);
        const normalized = normalizeSaleMetadata(body);
        if (!normalized.ok) {
          if ("invalid" in normalized) throw new SocialRouteError("invalid_request");
          recordMetric("social.sale_metadata", { operation: "write", outcome: normalized.refusal.code });
          throw new SocialRouteError(normalized.refusal.code, { extra: { field: normalized.refusal.field } });
        }
        const { tagline } = normalized.values;
        if (tagline && (await findBlockedTerm(tagline)) !== null) throw new SocialRouteError("blocked_term", { extra: { field: "tagline" } });
        const accountId = context.account!.account_id;
        const written = await timed("social.sale_metadata", () =>
          context.transaction(
            (social) => writeSaleMetadata(social, presaleId, normalized.values as SaleMetadataChange, { accountId }),
            { label: "social.sale_metadata_write" },
          ),
        { operation: "write" });
        if (written.changed) recordMetric("social.sale_metadata", { operation: "write", outcome: "changed" });
        return context.json(answer(presaleId, written.stored, true));
      }),
    }),

    cover: Object.freeze({
      POST: kit.route({ ...account, name: SOCIAL_SALE_COVER_UPLOAD_ROUTE, bucket: "social_picture_upload" }, async (context) => {
        const presaleId = saleIdParameter(context.request);
        const target = store();
        if (!target) throw new SocialRouteError("cover_upload_unavailable");
        const upload = await readCoverUpload(context.request);
        await editable(context, presaleId);
        const accountId = context.account!.account_id;
        const written = await timed("social.sale_metadata", async () => {
          const sanitized = await sanitizeSquareImage(upload.bytes, upload.declared, SALE_COVER_IMAGE);
          if (!sanitized.ok) throw new SocialRouteError("invalid_cover", { extra: { reason: sanitized.reason } });
          const cover = await storeCover(target, saleCoverFolder(presaleId), sanitized);
          if (!cover) throw new SocialRouteError("cover_upload_unavailable");
          return context.transaction(
            (social) => writeSaleMetadata(social, presaleId, { cover }, { accountId }),
            { label: "social.sale_metadata_cover" },
          );
        }, { operation: "cover" });
        await removeReplaced(written.before, written.stored);
        return context.json(answer(presaleId, written.stored, true), 201);
      }),

      DELETE: kit.route({ ...account, name: SOCIAL_SALE_COVER_DELETE_ROUTE, bucket: "social_account_update" }, async (context) => {
        const presaleId = saleIdParameter(context.request);
        await editable(context, presaleId);
        const accountId = context.account!.account_id;
        const written = await timed("social.sale_metadata", () =>
          context.transaction(
            (social) => writeSaleMetadata(social, presaleId, { cover: null }, { accountId }),
            { label: "social.sale_metadata_cover" },
          ),
        { operation: "cover_delete" });
        await removeReplaced(written.before, written.stored);
        return new Response(null, { status: 204, headers: { "Cache-Control": "private, no-store", "X-Request-ID": context.requestId } });
      }),
    }),
  });
}

export type SocialSaleRoutes = ReturnType<typeof createSocialSaleRoutes>;
