import { routeSegments } from "@blast/core/modules/backend-api/route-path.ts";
import { PRESALE_ALLOWLIST_BIND_PATH, PRESALE_ALLOWLIST_ENTRIES_PATH, PRESALE_ALLOWLIST_PATH } from "@blast/core/modules/backend-api/private/presale-contracts.ts";
import { z } from "zod";
import { randomUUID } from "node:crypto";

import { buildAllowlistOffThread } from "./build.ts";
import type { Pool } from "pg";

import type {
  AllowlistResponse,
  AllowlistWarning,
} from "@blast/core/modules/presale/contracts/web-api.ts";
import { recordPresaleMetric } from "@blast/core/modules/presale/redaction/redaction.ts";
import type { PresalePrincipal } from "@blast/core/modules/presale/route-kit/contracts.ts";
import { PresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";
import type { PresaleRouteKit } from "@blast/core/modules/presale/route-kit/route.ts";
import type { AllowedQuotes } from "./policy.ts";
import { addCardHolders, cardHolderWallets } from "./card-holders.ts";
import {
  findOwnedAllowlist,
  findOwnedAllowlistEntries,
  insertAllowlist,
  type AllowlistOwner,
} from "./repository.ts";
import { readAllowlistUpload } from "./upload.ts";

export type AllowlistRouteDependencies = Readonly<{
  kit: PresaleRouteKit;
  /** The primary pool, resolved per request. */
  pool: () => Pool;
  allowedQuotes: AllowedQuotes;
}>;

const ALLOWLIST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const QUOTE_NOT_ALLOWED: AllowlistWarning = {
  code: "quote_not_allowed",
  message:
    "The current creation policy does not allow this Quote; a sale with it cannot be created.",
};

/** A manifest belongs to the API key that created it, else to the Privy account. */
export function ownerOf(principal: PresalePrincipal | null): AllowlistOwner {
  if (principal?.kind === "api_key") return { kind: "api_key", id: principal.keyId };
  if (principal?.kind === "account") return { kind: "account", id: principal.did };
  throw new PresaleRouteError("unauthorized");
}

const ALLOWLIST_PATHS = [PRESALE_ALLOWLIST_PATH, PRESALE_ALLOWLIST_ENTRIES_PATH, PRESALE_ALLOWLIST_BIND_PATH] as const;

/** `{allowlist_id}` of an allowlist route: a lowercase UUID, else `invalid_parameter` (CL-21). */
export function allowlistId(request: Request): string {
  const pathname = new URL(request.url).pathname;
  const id = ALLOWLIST_PATHS.map((path) => routeSegments(path, pathname)).find((segments) => segments !== null)?.allowlist_id ?? "";
  if (!z.string().regex(ALLOWLIST_ID).safeParse(id).success)
    throw new PresaleRouteError("invalid_parameter");
  return id;
}

/**
 * The allowlist routes (interface contract 3.2, CL-6, CL-15, CL-21):
 *
 * - `create`: `POST /api/presale/allowlists`, a Privy token or an agent API
 *   key (`X-Blast-Api-Key`), bucket `presale_allowlist`. Reads the upload,
 *   optionally includes card holders at the mean uploaded cap,
 *   builds the tree with the SDK's `buildAllowlist` (creator rows first),
 *   adds `quote_not_allowed` when the creation policy does not allow
 *   the Quote, stores the manifest and every proof in one transaction, and
 *   answers 201 with the summary.
 * - `read`: `GET /api/presale/allowlists/{allowlist_id}`, the owner's summary;
 *   anyone else gets `not_found`.
 *
 * The upload's content is never logged: metrics carry counts and timings only.
 */
export function createAllowlistRoutes(dependencies: AllowlistRouteDependencies) {
  const create = dependencies.kit.route(
    {
      name: "POST /api/presale/allowlists",
      auth: "account_or_api_key",
      bucket: "presale_allowlist",
    },
    async (context) => {
      const owner = ownerOf(context.principal);
      const started = performance.now();
      const [upload, allowed] = await Promise.all([
        readAllowlistUpload(context.request),
        dependencies.allowedQuotes(),
      ]);
      const holders = upload.includeBlastHolders
        ? addCardHolders(upload.entries, await cardHolderWallets(dependencies.pool()))
        : null;
      const entries = holders?.entries ?? upload.entries;
      const built = await buildAllowlistOffThread(entries, context.request.signal);
      const warnings = allowed && !allowed.includes(upload.quote) ? [QUOTE_NOT_ALLOWED, ...upload.warnings] : upload.warnings;
      const totalCap = entries.reduce((sum, entry) => sum + entry.walletCap, 0n);
      const id = randomUUID();
      await insertAllowlist(dependencies.pool(), {
        id,
        owner,
        quote: upload.quote,
        root: built.root,
        leafCount: built.leafCount,
        totalCap,
        warnings,
        proofs: built.proofs,
        source: {
          file_name: upload.fileName ?? "allowlist.csv",
          uploaded_count: upload.entries.length,
          include_blast_holders: upload.includeBlastHolders ?? false,
          added_count: holders?.added ?? 0,
          holder_cap: holders ? `${holders.cap}` : null,
        },
      });
      const body: AllowlistResponse = {
        allowlist_id: id,
        root: built.root,
        leaf_count: `${built.leafCount}`,
        entry_count: entries.length,
        total_cap: `${totalCap}`,
        warnings,
      };
      recordPresaleMetric("presale.allowlist", {
        outcome: "created",
        owner: owner.kind,
        entries: entries.length,
        warnings: warnings.length,
        durationMs: Math.round(performance.now() - started),
      });
      return context.json(body, 201);
    },
  );

  const read = dependencies.kit.route(
    {
      name: "GET /api/presale/allowlists/{allowlist_id}",
      auth: "account_or_api_key",
      bucket: "presale_allowlist_read",
    },
    async (context) => {
      const owner = ownerOf(context.principal);
      const found = await findOwnedAllowlist(
        dependencies.pool(),
        allowlistId(context.request),
        owner,
      );
      if (!found) throw new PresaleRouteError("not_found");
      return context.json(found);
    },
  );

  const entries = dependencies.kit.route(
    {
      name: "GET /api/presale/allowlists/{allowlist_id}/entries",
      auth: "account_or_api_key",
      bucket: "presale_allowlist_read",
    },
    async (context) => {
      const found = await findOwnedAllowlistEntries(
        dependencies.pool(),
        allowlistId(context.request),
        ownerOf(context.principal),
      );
      if (!found) throw new PresaleRouteError("not_found");
      return context.json(found);
    },
  );
  return Object.freeze({ create, read, entries });
}

export type AllowlistRoutes = ReturnType<typeof createAllowlistRoutes>;
