"use client";

import { SuiGrpcClient } from "@mysten/sui/grpc";
import { track } from "@vercel/analytics";
import { useRouter } from "next/navigation";
import { useCallback, useMemo } from "react";

import type { SigningChainConfig } from "@blast/core/modules/launchpad-coin/signing-chain.ts";

import { LaunchpadWalletSignerProvider } from "../transaction/LaunchpadWalletSignerProvider";
import type { LaunchpadChain } from "../transaction/preflight";
import { CompleteMigration, MigrationUnavailable } from "./CompleteMigration";
import type { MigrationDiagnostic } from "./migration-flow";

const NOT_CONNECTED = "This app is not connected to a released Blast deployment, so it cannot sign a migration yet.";

/** Manual-fallback diagnostics through the site's analytics; closed-list properties only, never blocking. */
function reportMigrationToAnalytics(diagnostic: MigrationDiagnostic): void {
  try {
    track("launchpad_migration", { ...diagnostic });
  } catch {
    // Diagnostics are optional; the migration carries on.
  }
}

/**
 * The coin page's Complete migration slot in the browser. With a signing
 * chain it mounts the wallet signers around the action; a verified
 * completion re-reads the page from the server. Without one it keeps the
 * action visible, disabled, with the reason.
 */
export function CoinMigration({
  launchId,
  venue,
  config,
  privyAppId,
  nonce,
}: Readonly<{
  launchId: string;
  venue: string;
  config: SigningChainConfig | null;
  privyAppId: string | null;
  nonce: string;
}>) {
  const router = useRouter();
  // One client per fullnode: a server refresh hands over an equal config, and the action keeps its chain anyway.
  const network = config?.network ?? null;
  const baseUrl = config?.baseUrl ?? null;
  const client = useMemo(
    () => (network && baseUrl ? new SuiGrpcClient({ network, baseUrl, format: "text" }) : null),
    [network, baseUrl],
  );
  const chain: LaunchpadChain | null = config && client && { client, manifest: config.manifest, mode: config.mode };
  const onCompleted = useCallback(() => router.refresh(), [router]);
  if (!config || !chain) return <MigrationUnavailable venue={venue} reason={NOT_CONNECTED} />;
  return (
    <LaunchpadWalletSignerProvider privyAppId={privyAppId} network={config.network} nonce={nonce}>
      <CompleteMigration
        launchId={launchId}
        venue={venue}
        chain={chain}
        report={reportMigrationToAnalytics}
        onCompleted={onCompleted}
      />
    </LaunchpadWalletSignerProvider>
  );
}
