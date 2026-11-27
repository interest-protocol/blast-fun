import type { ModuleTransaction } from "@blast/core/modules/database/transaction.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { WALLET_SESSION_ACTIVE_SQL } from "@blast/core/modules/social/wallet-sign-in/sessions.ts";

import type { SocialCaller } from "../route-kit/route.ts";

export async function assertWalletSessionActive(social: ModuleTransaction<"social">, caller: SocialCaller): Promise<void> {
  if (caller.kind !== "wallet") return;
  const session = caller.sessionId ? await social.read<{ active: boolean }>(
    `SELECT ${WALLET_SESSION_ACTIVE_SQL} AS active`,
    [caller.address, caller.sessionId],
  ) : null;
  if (!session?.rows[0]?.active) {
    throw Object.assign(new SocialRouteError("unauthorized"), { clearWallet: true });
  }
}
