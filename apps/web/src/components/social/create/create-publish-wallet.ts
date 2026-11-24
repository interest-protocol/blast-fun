import { PublicError } from "#web/lib/errors.ts";
import { toBase64 } from "@mysten/sui/utils";
import { match } from "ts-pattern";

import { fetchWallet } from "../coins/coins-client.ts";
import type { PrivyCoinSigner } from "../coins/signers.tsx";
import type { PublishSigner } from "../publish-transaction.ts";
import { walletCommitSigner } from "../commit/commit-signers.ts";
import type { CreateApiOptions } from "./create-client.ts";

/** Publishing uses the canonical wallet; Blast pays its gas, an embedded wallet's or a wallet session's (owner ruling 2026-11-20). */
export async function loadPublishSigner(
  api: CreateApiOptions,
  expectedAddress: string | null,
  privy: PrivyCoinSigner | null,
): Promise<PublishSigner> {
  const wallet = await fetchWallet(api);
  if (wallet.status !== "ok" || !wallet.body.address || wallet.body.address !== expectedAddress) {
    throw new PublicError("Your publishing wallet couldn’t be verified. Reload and try again.");
  }

  const address = wallet.body.address;
  return match(wallet.body.signer)
    .with("privy", () => embeddedPublishSigner(privy, address))
    .with("wallet", () => externalPublishSigner(address))
    .exhaustive();
}

function embeddedPublishSigner(privy: PrivyCoinSigner | null, address: string): PublishSigner {
  const embedded = privy?.signer();
  if (!embedded || embedded.fee !== "sponsored" || embedded.address !== address) {
    throw new PublicError("Your embedded wallet isn’t ready. Try again.");
  }

  return {
    address,
    fee: "sponsored",
    async sign(bytes) {
      return { bytes: toBase64(bytes), signature: await embedded.signTransaction(bytes) };
    },
  };
}

/** A wallet session's wallet signs the sponsor's bytes; `sendPublishTransaction` refuses any it changed. */
function externalPublishSigner(address: string): PublishSigner {
  const wallet = walletCommitSigner(address);
  return {
    address,
    fee: "sponsored",
    async sign(bytes) {
      const signed = await wallet.signTransaction(bytes);
      return typeof signed === "string" ? { bytes: toBase64(bytes), signature: signed } : signed;
    },
  };
}
