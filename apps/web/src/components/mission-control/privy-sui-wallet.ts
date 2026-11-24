import { Signer, type SignatureScheme } from "@mysten/sui/cryptography";
import { Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519";
import {
  fromBase64,
  fromHex,
  normalizeSuiAddress,
  toHex,
} from "@mysten/sui/utils";
import { publicKeyFromRawBytes, publicKeyFromSuiBytes } from "@mysten/sui/verify";

type LinkedAccountLike = Readonly<{
  address?: string;
  chainType?: string;
  connectorType?: string;
  id?: string | null;
  imported?: boolean;
  publicKey?: string;
  recoveryMethod?: string;
  type?: string;
  walletClientType?: string;
}>;

type UserWithLinkedAccounts = Readonly<{
  linkedAccounts?: readonly LinkedAccountLike[];
}>;

export type EmbeddedSuiWallet = Readonly<{
  address: string;
  publicKey: string | null;
}>;

export type SignRawHash = (input: Readonly<{
  address: string;
  chainType: "sui";
  hash: `0x${string}`;
}>) => Promise<Readonly<{ signature: `0x${string}` }>>;

export function findEmbeddedSuiWallet(
  user: UserWithLinkedAccounts | null,
): EmbeddedSuiWallet | null {
  const wallet = user?.linkedAccounts?.find(
    (account) =>
      account.type === "wallet" &&
      account.chainType === "sui" &&
      account.connectorType === "embedded" &&
      account.walletClientType === "privy" &&
      account.imported === false &&
      typeof account.id === "string" &&
      account.recoveryMethod === "privy-v2",
  );
  if (!wallet?.address) return null;

  return {
    address: normalizeSuiAddress(wallet.address),
    publicKey: wallet.publicKey ?? null,
  };
}

// Privy sends Sui's flag-prefixed key as 66 hex characters with no 0x. Raw
// keys are 64. Both are also valid base64, so hex must be tried first.
const PUBLIC_KEY_HEX = /^(?:0x)?(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{66})$/;

function decodePublicKey(value: string): Ed25519PublicKey {
  let cause: unknown;
  try {
    const bytes = PUBLIC_KEY_HEX.test(value) ? fromHex(value) : fromBase64(value);
    const publicKey =
      bytes.length === Ed25519PublicKey.SIZE
        ? publicKeyFromRawBytes("ED25519", bytes)
        : publicKeyFromSuiBytes(bytes);
    if (publicKey instanceof Ed25519PublicKey) return publicKey;
  } catch (error) {
    cause = error;
  }
  throw new Error("Privy returned an unsupported Sui public key encoding.", {
    cause,
  });
}

function decodeSignature(value: `0x${string}`): Uint8Array {
  const hex = value.slice(2);
  if (!/^[0-9a-fA-F]{128}$/.test(hex)) {
    throw new Error("Privy returned an invalid Sui signature.");
  }
  return fromHex(hex);
}

class PrivySuiSigner extends Signer {
  readonly #address: string;
  readonly #publicKey: Ed25519PublicKey;
  readonly #signRawHash: SignRawHash;

  constructor(wallet: EmbeddedSuiWallet, signRawHash: SignRawHash) {
    super();
    if (!wallet.publicKey) {
      throw new Error("The embedded Sui wallet public key is unavailable.");
    }

    this.#publicKey = decodePublicKey(wallet.publicKey);
    this.#address = normalizeSuiAddress(wallet.address);
    this.#signRawHash = signRawHash;

    if (this.#publicKey.toSuiAddress() !== this.#address) {
      throw new Error("The embedded Sui wallet key does not match its address.");
    }
  }

  async sign(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    const { signature } = await this.#signRawHash({
      address: this.#address,
      chainType: "sui",
      hash: `0x${toHex(bytes)}`,
    });
    return decodeSignature(signature) as Uint8Array<ArrayBuffer>;
  }

  getKeyScheme(): SignatureScheme {
    return "ED25519";
  }

  getPublicKey(): Ed25519PublicKey {
    return this.#publicKey;
  }
}

/** A Sui signer backed by Privy raw-hash signing for the embedded wallet. */
export function privySuiSigner(wallet: EmbeddedSuiWallet, signRawHash: SignRawHash): Signer {
  return new PrivySuiSigner(wallet, signRawHash);
}
