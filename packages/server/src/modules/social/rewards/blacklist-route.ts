import { z } from "zod";
import { socialInput } from "@blast/server/modules/social/route-kit/validation.ts";

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { operatorRoute } from "@blast/core/modules/backend-api/operator-routes.ts";
import {
  autocommitReader,
  withTransaction,
} from "@blast/core/modules/database/transaction.ts";
import { isValidStructTag, normalizeStructTag } from "@mysten/sui/utils";
import {
  REWARD_BLACKLIST_LIMIT,
  readRewardBlacklist,
  readRewardTeamWallets,
  saveRewardBlacklist,
} from "@blast/core/modules/presale/rewards/blacklist.ts";
import {
  SocialRouteError,
  toSocialRouteError,
} from "@blast/core/modules/social/route-kit/errors.ts";
import {
  readSocialJson,
  socialJson,
  socialErrorResponse,
} from "@blast/server/modules/social/route-kit/route.ts";
import { readRewardCoins, rewardCoinQuery } from "@blast/server/modules/social/rewards/blacklist-coins.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

class RewardBlacklistConflict extends Error {}

function coinParameter(request: Request): string {
  try {
    const coin = decodeURIComponent(
      operatorRoute(new URL(request.url).pathname)?.params.coin_type ?? "",
    );
    return socialInput(z.string().max(2048).regex(/^0x[0-9a-f]{64}::/)
      .refine((value) => isValidStructTag(value) && normalizeStructTag(value) === value, { when: ({ issues }) => issues.length === 0 }), coin, "invalid_parameter");
  } catch {
    /* Invalid URI escapes and type tags are invalid parameters. */
  }
  throw new SocialRouteError("invalid_parameter", {
    extra: { parameter: "coin_type" },
  });
}

function walletsOf(value: unknown): string[] {
  const wallets = socialInput(z.array(z.string().regex(SUI_OBJECT_ID_PATTERN)).max(REWARD_BLACKLIST_LIMIT), value);
  return [...new Set(wallets)].sort();
}

export function createAdminRewardBlacklistRoute(
  dependencies: Readonly<{
    pool: () => Pool;
    scope: () => Readonly<{ network: string; originalPackageId: string }>;
  }>,
) {
  return async (request: Request): Promise<Response> => {
    const requestId = randomUUID();
    try {
      if (new URL(request.url).pathname === "/api/admin/reward-coins") {
        if (request.method !== "GET") {
          return new Response(null, {
            status: 405,
            headers: { Allow: "GET", "Cache-Control": "no-store" },
          });
        }
        const query = rewardCoinQuery(request);
        dependencies.scope();
        return socialJson(
          requestId,
          await readRewardCoins(
            autocommitReader(dependencies.pool(), "social"),
            query,
          ),
        );
      }
      if (request.method !== "GET" && request.method !== "PUT") {
        return new Response(null, {
          status: 405,
          headers: { Allow: "GET, PUT", "Cache-Control": "no-store" },
        });
      }
      const coin = coinParameter(request);
      const change =
        request.method === "PUT"
          ? await readSocialJson(
              request,
              ["wallets"],
              ["expected_wallets"],
              8192,
            )
          : undefined;
      const wallets = change ? walletsOf(change.wallets) : undefined;
      const expectedWallets =
        change && Object.hasOwn(change, "expected_wallets")
          ? walletsOf(change.expected_wallets)
          : undefined;
      const scope = dependencies.scope();
      const body = await withTransaction(
        dependencies.pool(),
        async (transaction) => {
          const db = transaction.forModule("social");
          const { rows: sales } = await db.read<{ presale_id: string }>(
            "SELECT presale_id FROM chain_read_v1.presales WHERE sale_token=$1 LIMIT 2",
            [coin],
          );
          if (sales.length === 0) throw new SocialRouteError("not_found");
          if (sales.length !== 1)
            throw new SocialRouteError("service_unavailable");
          const { rows: cuts } = await db.read<{
            checkpoint: string;
            checkpoint_digest: string;
            deployment_fingerprint: string;
          }>(
            `SELECT checkpoint::text,checkpoint_digest,deployment_fingerprint FROM chain_read_v1.projection_coverage
          WHERE network=$1 AND pipeline='presale' AND fault_checkpoint IS NULL`,
            [scope.network],
          );
          const cut = cuts[0];
          if (!cut?.checkpoint)
            throw new SocialRouteError("service_unavailable");
          await db.read(
            "SELECT chain_read_v1.require_cut($1,$2,$3,$4,ARRAY['presale'])",
            [
              scope.network,
              cut.deployment_fingerprint,
              cut.checkpoint,
              cut.checkpoint_digest,
            ],
          );
          const teamWallets = await readRewardTeamWallets(db, {
            presaleId: sales[0]!.presale_id,
            coinType: coin,
            originalPackageId: scope.originalPackageId,
            endCheckpoint: cut.checkpoint,
          });
          if (wallets !== undefined) {
            const saved = await saveRewardBlacklist(
              db,
              scope.network,
              coin,
              wallets,
              "admin-api",
              expectedWallets,
            );
            if (!saved) throw new RewardBlacklistConflict();
          }
          return {
            coin_type: coin,
            wallets:
              wallets ?? (await readRewardBlacklist(db, scope.network, coin)),
            team_wallets: teamWallets,
          };
        },
        { isolationLevel: "REPEATABLE READ", label: "admin.reward_blacklist" },
      );
      return socialJson(requestId, body);
    } catch (error) {
      if (error instanceof RewardBlacklistConflict) {
        return socialJson(
          requestId,
          {
            error: {
              code: "REWARD_BLACKLIST_CONFLICT",
              message:
                "The blacklist changed. Refresh and review the current wallets before trying again.",
            },
          },
          409,
        );
      }
      return socialErrorResponse(requestId, toSocialRouteError(error));
    }
  };
}
