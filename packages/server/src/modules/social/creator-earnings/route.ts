import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { SocialCaller, SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import type { CreatorChain } from "@blast/server/modules/social/creator-earnings/chain.ts";
import { readCreatorEarnings } from "@blast/server/modules/social/creator-earnings/read.ts";

export function createCreatorEarningsRoute(
  dependencies: Readonly<{
    kit: SocialRouteKit;
    database: () => ReadableDatabase;
    chain: (signal: AbortSignal) => Promise<CreatorChain | null>;
    blastWallet: (caller: SocialCaller) => Promise<string | null>;
    now?: () => number;
  }>,
) {
  return dependencies.kit.route(
    {
      name: "GET /api/social/me/creator-earnings",
      auth: "account",
      account: "required",
      bucket: "social_read",
      cache: "private",
    },
    async (context) => {
      const query = new URL(context.request.url).searchParams;
      const { cursor } = socialInput(z.object({
        keys: z.array(z.literal("cursor")), cursor: socialAddressSchema.nullable(),
      }), { keys: [...query.keys()], cursor: query.get("cursor") }, "invalid_parameter");
      const sender = await readStep("creator_earnings", "blast_wallet", () => dependencies.blastWallet(context.caller!));
      if (!sender) throw new SocialRouteError("blast_wallet_missing");
      const chain = await readStep("creator_earnings", "chain", () => dependencies.chain(context.request.signal));
      if (!chain) throw new SocialRouteError("claim_unavailable");
      return context.json(
        await readCreatorEarnings(
          dependencies.database(),
          chain,
          sender,
          cursor,
          (dependencies.now ?? Date.now)(),
          context.request.signal,
        ),
      );
    },
  );
}
import { z } from "zod";

import { socialAddressSchema } from "@blast/core/modules/social/contracts/primitives.ts";
import { socialInput } from "@blast/server/modules/social/route-kit/validation.ts";
import { readStep } from "@blast/server/modules/social/read-steps.ts";
