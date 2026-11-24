import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

/** The Ed25519 key whose public half `RuntimeConfig.creator_claim_signer_public_key` holds. */
export type CreatorClaimSigner = Readonly<{
  publicKey: Uint8Array;
  /** A raw Ed25519 signature over `message`: no intent prefix and no hash, as the contract verifies. */
  sign(message: Uint8Array): Promise<Uint8Array>;
}>;

export const CREATOR_CLAIM_SIGNER_ENV = "CREATOR_CLAIM_SIGNER_KEY";

export function creatorClaimSigner(keypair: Ed25519Keypair): CreatorClaimSigner {
  return Object.freeze({
    publicKey: keypair.getPublicKey().toRawBytes(),
    sign: (message: Uint8Array) => keypair.sign(message),
  });
}

/**
 * The signer from `CREATOR_CLAIM_SIGNER_KEY`, a Sui `suiprivkey1…` Ed25519 key; null while it is
 * unset, so account claims stay off. A key of another scheme or a malformed one throws, with a
 * message that never repeats the key: a misconfigured signer must not be mistaken for an absent one.
 */
export function creatorClaimSignerFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): CreatorClaimSigner | null {
  const value = environment[CREATOR_CLAIM_SIGNER_ENV]?.trim();
  if (!value) return null;
  const invalid = new Error(`${CREATOR_CLAIM_SIGNER_ENV} must be a Sui Ed25519 private key.`);
  let decoded: ReturnType<typeof decodeSuiPrivateKey>;
  try {
    decoded = decodeSuiPrivateKey(value);
  } catch {
    throw invalid;
  }
  if (decoded.scheme !== "ED25519") throw invalid;
  return creatorClaimSigner(Ed25519Keypair.fromSecretKey(decoded.secretKey));
}
