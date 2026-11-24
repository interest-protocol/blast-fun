import type { SignerSource } from "../transaction/controller";
import type { LaunchpadSigner } from "../transaction/signer";

/** Controllers keep this source while the shared account signs in, changes, or signs out. */
export function createSessionSignerSource() {
  let signer: LaunchpadSigner | null = null;
  const source: SignerSource = {
    kinds: ["privy", "wallet"],
    current: () => signer,
    async connect() {
      if (!signer)
        throw new Error(
          "Your Blast wallet is unavailable. Sign in and try again.",
        );
      return signer;
    },
  };
  return {
    source,
    update(next: LaunchpadSigner | null) {
      signer = next;
    },
  };
}
