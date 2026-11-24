import { primaryPool } from "@blast/core/modules/database/pool.ts";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { launchAssetStore } from "@blast/server/modules/launch-assets/store.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { findBlockedTerm } from "@blast/core/modules/social/config/reader.ts";
import { sharedSocialRouteKit, socialMainnetClient } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { presaleCapEditor, type SaleEditorFullnode, type SaleEditorSource } from "@blast/server/modules/social/sales/editor.ts";
import { createSocialSaleRoutes, type SocialSaleRoutes } from "@blast/server/modules/social/sales/route.ts";

/** The mainnet node the editor check reads (`socialMainnetClient`), one per process. */
function mainnet(): SaleEditorFullnode {
  const client = socialMainnetClient("social.sales-fullnode");
  return { getObject: (input) => client.core.getObject(input) as ReturnType<SaleEditorFullnode["getObject"]> };
}

/** The process's editor check (the sale's `PresaleCap` holder on mainnet, kept a minute), shared by the sale routes and Create. */
export function saleEditor(): SaleEditorSource {
  return processSingleton("social.sale-editor", () => presaleCapEditor(mainnet));
}

/**
 * The production sale details routes over the shared social kit: reads and
 * writes on the primary, the cached blocked terms, the editor from mainnet
 * (the sale's `PresaleCap` holder, kept a minute) and covers in the public
 * launch-asset Blob store (`LAUNCH_ASSET_BLOB_READ_WRITE_TOKEN`; without it a
 * cover upload answers `cover_upload_unavailable`, and the text and links
 * still save).
 */
export function socialSaleRoutes(): SocialSaleRoutes {
  return processSingleton("social.sale-routes", () => {
    const store = launchAssetStore(runtimeConfig().launchAssetBlobToken);
    return createSocialSaleRoutes({
      kit: sharedSocialRouteKit(),
      findBlockedTerm,
      editor: saleEditor(),
      store: () => store,
      database: () => autocommitReader(primaryPool(), "social", { label: "social.sale_metadata" }),
    });
  });
}
