import type { SocialWorkerStep } from "../worker/steps.ts";

/** Registration and acknowledgement share one transaction; retries cannot lose a linked wallet. */
export const registerWalletsStep: SocialWorkerStep = {
  name: "wallet-registration",
  pipeline: null,
  async run(tx) {
    const { rows } = await tx.read<{ owner: string }>(
      "SELECT owner FROM social_wallet_balance_requests ORDER BY requested_at, owner LIMIT 1000 FOR UPDATE SKIP LOCKED",
    );
    if (rows.length === 0) return {};
    const owners = rows.map((row) => row.owner);
    await tx.read("SELECT chain_read_v1.track_wallets($1::text[])", [owners]);
    await tx.write("social_wallet_balance_requests", "DELETE FROM social_wallet_balance_requests WHERE owner = ANY($1::text[])", [owners]);
    return {};
  },
};
