// Presale deployment identity fixtures for tests and local rehearsals: a
// mainnet-shaped identity with hash-derived IDs, which production refuses as a
// fixture, and the fixture node that answers its chain identifier. Nothing
// here is a real deployment.

import { defineBlastDeployment, presaleDeployment } from "@interest-protocol/blast-sdk/deployments";

import type { ChainIdentifierNode } from "../../../../../src/modules/presale/deployment/contracts.ts";
import { NON_PRODUCTION_MANIFEST } from "../../launchpad-coin/manifest-fixtures.ts";
import { presaleFixtureObjectId } from "../../../../../src/modules/presale/deployment/service.ts";

const fixtureId = presaleFixtureObjectId;

/** Sui mainnet's genesis checkpoint digest, as the Core API reports it. */
export const SUI_MAINNET_CHAIN_IDENTIFIER = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S";
export const SUI_TESTNET_CHAIN_IDENTIFIER = "69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD";

const shared = (label: Parameters<typeof presaleFixtureObjectId>[0]) => ({ objectId: fixtureId(label), initialSharedVersion: "7" });

/** A valid mainnet-shaped fixture identity as `PRESALE_DEPLOYMENT_MANIFEST` carries it. */
export function presaleIdentityFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    network: "mainnet",
    chainIdentifier: SUI_MAINNET_CHAIN_IDENTIFIER,
    contractsCommit: "c36057d4eaea8e284e24fda4fd459eb721731b14",
    sdkCommit: "d212a92d2821ad3b2f33356f5da200081f087a38",
    presale: {
      ...presaleDeployment(defineBlastDeployment(NON_PRODUCTION_MANIFEST)),
      packageId: fixtureId("presale-package"),
      originalPackageId: fixtureId("presale-package"),
      packageVersion: shared("package-version"),
      creationPolicy: shared("creation-policy"),
      feePolicy: shared("fee-policy"),
      admin: { packageId: fixtureId("admin-package"), originalPackageId: fixtureId("admin-package"), acl: shared("admin-acl") },
    },
    publishCheckpoint: "1200",
    venues: {
      cetus: { globalConfig: shared("cetus-global-config"), pools: shared("cetus-pools"), burnManager: shared("cetus-burn-manager") },
      bluefin: { globalConfig: shared("bluefin-global-config") },
      aftermath: {
        vendorPackageId: fixtureId("aftermath-vendor-package"),
        poolRegistry: shared("aftermath-pool-registry"),
        daoFeeVersion: shared("aftermath-dao-fee-version"),
      },
    },
    ...overrides,
  };
}

/**
 * A fixture node that reports `chainIdentifier`, counting its calls. `fail`
 * makes it unreachable; `hang` makes it accept the call and never answer,
 * ignoring any abort signal.
 */
export function fixtureChainNode(
  chainIdentifier: string,
  options: Readonly<{ fail?: boolean; hang?: boolean }> = {},
): ChainIdentifierNode & { calls: number } {
  const node = {
    calls: 0,
    core: {
      async getChainIdentifier() {
        node.calls += 1;
        if (options.hang) return new Promise<never>(() => undefined);
        if (options.fail) throw new Error("fixture node unreachable");
        return { chainIdentifier };
      },
    },
  };
  return node;
}
