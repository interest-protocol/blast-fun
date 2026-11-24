import type { ClientWithCoreApi } from "@mysten/sui/client";
import { parseSerializedSignature } from "@mysten/sui/cryptography";
import { MultiSigPublicKey } from "@mysten/sui/multisig";
import { isValidTransactionSignature } from "@mysten/sui/verify";
import { ZkLoginPublicIdentifier } from "@mysten/sui/zklogin";

/**
 * Whether `signature` signs `txBytes` for `address`. A wrong signature is
 * `false`; a node that cannot answer rejects, so the caller can answer
 * "try again" without counting it as a wrong signature.
 */
export type SponsorSignatureVerifier = (
  txBytes: Uint8Array,
  signature: string,
  address: string,
) => Promise<boolean>;

/**
 * Plain keys (embedded wallets, extension wallets, passkeys) are checked
 * locally. A zkLogin signature (Slush's Google or Apple accounts) carries a
 * proof only a node can check, so it goes to `client()`: the node of the
 * network the reservation was built for. The SDK throws for zkLogin offline,
 * which is why a local-only check refused every such wallet.
 */
export function createSponsorSignatureVerifier(
  client: () => ClientWithCoreApi,
): SponsorSignatureVerifier {
  return async (txBytes, signature, address) => {
    let parsed: ReturnType<typeof parseSerializedSignature>;
    try {
      parsed = parseSerializedSignature(signature);
    } catch {
      return false;
    }
    const zkLogin =
      parsed.signatureScheme === "ZkLogin" ||
      (parsed.signatureScheme === "MultiSig" &&
        parsed.multisig.sigs.some((partial) => "ZkLogin" in partial));
    if (zkLogin) {
      // A proof for another address is wrong without asking the node.
      if (!signsFor(parsed, address)) return false;
      return isValidTransactionSignature(txBytes, signature, {
        address,
        client: client(),
        checkAddressAliases: false,
      });
    }
    return isValidTransactionSignature(txBytes, signature, {
      address,
      offline: true,
    }).catch(() => false);
  };
}

/** Whether a zkLogin or multisig signature's public key is `address` (new or legacy zkLogin form). */
function signsFor(parsed: ReturnType<typeof parseSerializedSignature>, address: string): boolean {
  try {
    if (parsed.signatureScheme === "ZkLogin")
      return new ZkLoginPublicIdentifier(parsed.publicKey).verifyAddress(address);
    if (parsed.signatureScheme === "MultiSig")
      return new MultiSigPublicKey(parsed.multisig.multisigPk).verifyAddress(address);
  } catch {
    return false;
  }
  return false;
}
