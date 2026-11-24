import type { Transaction } from "@mysten/sui/transactions";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import type { SponsorCaller } from "@blast/server/modules/sponsor/caller.ts";
import type { PresaleSponsorService } from "@blast/server/modules/sponsor/service.ts";
import { fromBase64 } from "@mysten/sui/utils";

/** Every caller, Privy or wallet session, gets sponsored gas; a refusal never falls back to wallet gas. */
export async function prepareVestingTransaction(
  transaction: Transaction,
  request: {
    sender: string;
    caller: SponsorCaller;
    ip: string;
    signal: AbortSignal;
  },
  chain: SuiGrpcClient,
  sponsor: Pick<PresaleSponsorService, "sponsor">,
) {
  transaction.setSender(request.sender);
  const kindBytes = await transaction.build({
    client: chain,
    onlyTransactionKind: true,
  });
  const reserved = await sponsor.sponsor({
    ...request,
    kindBytes,
    intent: "vesting",
    presaleId: null,
  });
  return {
    bytes: fromBase64(reserved.transaction_bytes),
    reservationId: reserved.reservation_id,
    expiresAt: reserved.expires_at_ms,
  };
}
