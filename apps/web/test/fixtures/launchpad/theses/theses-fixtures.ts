// Development fixtures for the Theses harness: two direct-wallet test keys
// that sign Wallet Proofs (personal messages) for the dev server's real
// /api/launchpad/theses. They are hash-free sequential test secrets, never
// real value; a fixture database names one of them a launch's creator.

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

import type { LaunchpadSigner } from "#web/components/launchpad/transaction/signer.ts";

const CREATOR_KEY = Ed25519Keypair.fromSecretKey(Uint8Array.from({ length: 32 }, (_, index) => index + 161));
const OTHER_KEY = Ed25519Keypair.fromSecretKey(Uint8Array.from({ length: 32 }, (_, index) => index + 181));

export type FixtureWallet = "creator" | "other";

export const THESES_FIXTURE_WALLETS: Readonly<Record<FixtureWallet, string>> = {
  creator: CREATOR_KEY.toSuiAddress(),
  other: OTHER_KEY.toSuiAddress(),
};

function refuseTransaction(): never {
  throw new Error("A thesis never signs a transaction.");
}

/** A fixture direct wallet that signs only personal messages. */
export function thesesFixtureWallet(wallet: FixtureWallet): LaunchpadSigner {
  const key = wallet === "creator" ? CREATOR_KEY : OTHER_KEY;
  return {
    kind: "wallet",
    label: wallet === "creator" ? "Fixture creator wallet" : "Fixture other wallet",
    address: key.toSuiAddress(),
    chain: null,
    signTransaction: async () => refuseTransaction(),
    signPersonalMessage: async (message) => (await key.signPersonalMessage(message)).signature,
  };
}

/** A fixture Privy signer: the token is one a fixture Privy issued; the address is that user's embedded wallet. */
export function thesesFixturePrivy(accessToken: string | null, embeddedWallet: string): LaunchpadSigner {
  return {
    kind: "privy",
    label: "Fixture Privy",
    address: embeddedWallet,
    chain: null,
    signTransaction: async () => refuseTransaction(),
    accessToken: async () => accessToken,
  };
}
