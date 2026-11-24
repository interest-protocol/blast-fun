import { normalizeStructTag } from "@mysten/sui/utils";

export function coinArtworkIdentity(coinType: string | undefined, fallbackId: string, network = "mainnet") {
  try { return `sui:${network}:${normalizeStructTag(coinType ?? fallbackId)}`; }
  catch { return `sui:${network}:presale:${fallbackId}`; }
}
