
import type { SignerKind } from "./action-machine";
import type { SignerSource } from "./controller";
import type { LaunchpadSigner } from "./signer";

/** What a mounted wallet bridge (Privy, dApp Kit, or a fixture) provides. */
export type SignerBridge = Readonly<{
  current(): LaunchpadSigner | null;
  connect(kind: SignerKind): Promise<LaunchpadSigner>;
}>;

export type RegisterSignerBridge = (bridge: SignerBridge | null) => void;

export const BRIDGE_TIMEOUT_MS = 20_000;

/**
 * A signer source whose wallet bridge is mounted only when the first action
 * asks to connect. Until then `current` is null and nothing is initialized.
 */
export function createLazySignerSource({
  kinds,
  activate,
  timeoutMs = BRIDGE_TIMEOUT_MS,
}: Readonly<{ kinds: readonly SignerKind[]; activate: () => void; timeoutMs?: number }>): Readonly<{
  source: SignerSource;
  register: RegisterSignerBridge;
}> {
  let bridge: SignerBridge | null = null;
  let activated = false;
  const waiting = new Set<(bridge: SignerBridge) => void>();

  function mounted(): Promise<SignerBridge> {
    if (bridge) return Promise.resolve(bridge);
    if (!activated) {
      activated = true;
      activate();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(ready);
        reject(new Error("The wallet connection could not start. Refresh the page and try again."));
      }, timeoutMs);
      function ready(next: SignerBridge) {
        clearTimeout(timer);
        resolve(next);
      }
      waiting.add(ready);
    });
  }

  return {
    source: {
      kinds,
      current: () => bridge?.current() ?? null,
      connect: async (kind) => (await mounted()).connect(kind),
    },
    register(next) {
      bridge = next;
      if (!next) return;
      for (const ready of waiting) ready(next);
      waiting.clear();
    },
  };
}
