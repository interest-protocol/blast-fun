"use client";

import { LaunchpadWalletSignerProvider } from "../transaction/LaunchpadWalletSignerProvider";
import styles from "./Theses.module.css";
import { ThesesBoard } from "./ThesesBoard";
import type { ThesesPosting } from "./theses-model";
import { ThesisComposer } from "./ThesisComposer";

/**
 * The coin page's Theses destination (on mobile, the Theses view): the
 * launch's public posts and, where this app can take posts, the post form
 * with Privy (when configured) and direct wallets for the deployment's network.
 */
export function CoinTheses({ launchId, symbol, posting }: Readonly<{ launchId: string; symbol: string | null; posting: ThesesPosting }>) {
  return (
    <ThesesBoard
      launchId={launchId}
      symbol={symbol}
      composer={(onPublished) =>
        "unavailable" in posting ? (
          <p className={styles.note}>{posting.unavailable}</p>
        ) : (
          <LaunchpadWalletSignerProvider privyAppId={posting.privyAppId} network={posting.network} nonce={posting.nonce}>
            <ThesisComposer launchId={launchId} onPublished={onPublished} />
          </LaunchpadWalletSignerProvider>
        )
      }
    />
  );
}
