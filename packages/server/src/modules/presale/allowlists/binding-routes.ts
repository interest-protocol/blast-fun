import { routeSegments } from "@blast/core/modules/backend-api/route-path.ts";
import { PRESALE_PROOF_PATH } from "@blast/core/modules/backend-api/private/presale-contracts.ts";
import { allowlistBindRequestSchema } from "@blast/core/modules/presale/contracts/allowlist-request.ts";
import { addressSchema } from "@blast/core/modules/presale/contracts/primitives.ts";
import type { Pool } from "pg";

import type {
  AllowlistBindResponse,
  AllowlistProofResponse,
} from "@blast/core/modules/presale/contracts/web-api.ts";
import type { PresaleRuntimeIdentity } from "@blast/core/modules/presale/deployment/contracts.ts";
import { recordPresaleMetric } from "@blast/core/modules/presale/redaction/redaction.ts";
import { PresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";
import {
  readJsonBody,
  type PresaleRequestContext,
  type PresaleRouteKit,
} from "@blast/core/modules/presale/route-kit/route.ts";
import { bindAllowlist, findAllowlistByRoot, findBoundProof } from "./bindings.ts";
import type { PresaleEligibilityReader } from "./eligibility.ts";
import { findOwnedAllowlist } from "./repository.ts";
import { allowlistId, ownerOf } from "./routes.ts";

export type AllowlistBindingRouteDependencies = Readonly<{
  kit: PresaleRouteKit;
  /** The primary pool, resolved per request. */
  pool: () => Pool;
  eligibility: PresaleEligibilityReader;
}>;

/** A bind body is one object ID, about 90 bytes. */
export const ALLOWLIST_BIND_BODY_LIMIT_BYTES = 1_024;

/** `{presale_id}` from `/api/presale/presales/{presale_id}/proof`, else `invalid_parameter` (CL-21). */
function proofPresaleId(request: Request): string {
  const id = routeSegments(PRESALE_PROOF_PATH, new URL(request.url).pathname)?.presale_id ?? "";
  if (!addressSchema.safeParse(id).success) throw new PresaleRouteError("invalid_parameter");
  return id;
}

/** `?wallet=` exactly once, canonical, else `invalid_parameter` (CL-21). */
function proofWallet(request: Request): string {
  const values = new URL(request.url).searchParams.getAll("wallet");
  if (values.length !== 1 || !addressSchema.safeParse(values[0]).success)
    throw new PresaleRouteError("invalid_parameter");
  return values[0];
}

/** The kit ran the `verified` deployment check, so the identity is present. */
function identityOf(context: PresaleRequestContext): PresaleRuntimeIdentity {
  if (!context.deployment) throw new PresaleRouteError("deployment_unavailable");
  return context.deployment;
}

/**
 * The bind and proof routes (interface contract 3.2, CL-6d/e, CL-11, CL-15,
 * CL-21). A manifest serves a sale only when its root and leaf count equal
 * the sale's on-chain allowlisted eligibility, read with the SDK's
 * `PresaleClient.getPresale` under the verified deployment identity.
 *
 * - `bind`: `POST /api/presale/allowlists/{allowlist_id}/bind`, the
 *   manifest's owner by Privy token or agent API key, bucket
 *   `presale_allowlist`. Another owner's manifest is `not_found`; a sale that
 *   is open, missing, or allowlisted with another root or leaf count is
 *   `root_mismatch` and nothing changes. A repeat bind, or a bind of another
 *   manifest with the same root and leaf count, is 200 and the sale keeps its
 *   first binding.
 * - `proof`: `GET /api/presale/presales/{presale_id}/proof?wallet=`, public,
 *   bucket `presale_proof` per IP. A bound sale is served from its manifest.
 *   An unbound sale is read on chain: allowlisted, it is bound to the
 *   earliest stored manifest with its root and leaf count
 *   (`allowlist_unknown` when there is none); open or missing, every wallet
 *   is `not_eligible`. An unlisted wallet is `not_eligible`.
 */
export function createAllowlistBindingRoutes(dependencies: AllowlistBindingRouteDependencies) {
  const bind = dependencies.kit.route(
    {
      name: "POST /api/presale/allowlists/{allowlist_id}/bind",
      auth: "account_or_api_key",
      bucket: "presale_allowlist",
      deployment: "verified",
    },
    async (context) => {
      const owner = ownerOf(context.principal);
      const id = allowlistId(context.request);
      const parsed = allowlistBindRequestSchema.safeParse(
        await readJsonBody(context.request, { maxBytes: ALLOWLIST_BIND_BODY_LIMIT_BYTES }),
      );
      if (!parsed.success) throw new PresaleRouteError("invalid_request");
      const presaleId = parsed.data.presale_id;
      const pool = dependencies.pool();
      const manifest = await findOwnedAllowlist(pool, id, owner);
      if (!manifest) throw new PresaleRouteError("not_found");
      const eligibility = await dependencies.eligibility(identityOf(context), presaleId);
      if (
        eligibility?.kind !== "allowlisted" ||
        eligibility.root !== manifest.root ||
        `${eligibility.leafCount}` !== manifest.leaf_count
      ) {
        recordPresaleMetric("presale.allowlist", { outcome: "root_mismatch", owner: owner.kind });
        throw new PresaleRouteError("root_mismatch");
      }
      const bound = await bindAllowlist(pool, { presaleId, allowlistId: id, boundBy: owner });
      recordPresaleMetric("presale.allowlist", {
        outcome: bound ? "bound" : "already_bound",
        owner: owner.kind,
      });
      const body: AllowlistBindResponse = {
        allowlist_id: id,
        presale_id: presaleId,
        root: manifest.root,
        leaf_count: manifest.leaf_count,
      };
      return context.json(body);
    },
  );

  const proof = dependencies.kit.route(
    {
      name: "GET /api/presale/presales/{presale_id}/proof",
      auth: "none",
      bucket: "presale_proof",
      deployment: "verified",
    },
    async (context) => {
      const presaleId = proofPresaleId(context.request);
      const wallet = proofWallet(context.request);
      const pool = dependencies.pool();
      let found = await findBoundProof(pool, presaleId, wallet);
      if (found === undefined) {
        const eligibility = await dependencies.eligibility(identityOf(context), presaleId);
        if (eligibility?.kind !== "allowlisted") throw new PresaleRouteError("not_eligible");
        const manifest = await findAllowlistByRoot(pool, eligibility.root, eligibility.leafCount);
        if (!manifest) {
          recordPresaleMetric("presale.allowlist", { outcome: "allowlist_unknown" });
          throw new PresaleRouteError("allowlist_unknown");
        }
        const bound = await bindAllowlist(pool, {
          presaleId,
          allowlistId: manifest,
          boundBy: "proof_route",
        });
        // A concurrent bind or auto-bind may have won the insert; the re-read serves whichever did.
        recordPresaleMetric("presale.allowlist", {
          outcome: bound ? "auto_bound" : "already_bound",
        });
        found = await findBoundProof(pool, presaleId, wallet);
      }
      if (!found) throw new PresaleRouteError("not_eligible");
      const body: AllowlistProofResponse = found;
      return context.json(body);
    },
  );

  return Object.freeze({ bind, proof });
}

export type AllowlistBindingRoutes = ReturnType<typeof createAllowlistBindingRoutes>;
