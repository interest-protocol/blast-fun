import type { BlastDeployment } from "@interest-protocol/blast-sdk/deployments";
import type { PresaleDeployment } from "@interest-protocol/blast-sdk/presale";

/** Blast runs on mainnet only; every other network is refused, tests included. */
export type PresaleNetwork = "mainnet";

export type PresaleSharedObject = Readonly<{
  objectId: string;
  /** A positive u64 decimal string. */
  initialSharedVersion: string;
}>;

/** The presale identities derived from the selected Blast deployment or a local fixture. */
export type PresaleRuntimeIdentity = Readonly<{
  schemaVersion: 2;
  manifest?: BlastDeployment;
  network: PresaleNetwork;
  /** The genesis checkpoint digest the node's Core API reports. */
  chainIdentifier: string;
  /** The published presale source commit (40 lowercase hex). */
  contractsCommit: string;
  /** The SDK source commit the backend runs (40 lowercase hex). */
  sdkCommit: string;
  presale: PresaleDeployment;
  /** Local rehearsal checkpoint. Published deployments carry their own evidence. */
  publishCheckpoint?: string;
  venues: Readonly<{
    cetus?: Readonly<{
      globalConfig: PresaleSharedObject;
      pools: PresaleSharedObject;
      burnManager: PresaleSharedObject;
    }>;
    bluefin?: Readonly<{ globalConfig: PresaleSharedObject }>;
    /** Published only as part of the complete Aftermath DAO venue identity. */
    aftermath?: Readonly<{
      vendorPackageId: string;
      poolRegistry: PresaleSharedObject;
      daoFeeVersion: PresaleSharedObject;
    }>;
  }>;
  cctp?: Readonly<{
    /** Package IDs. */
    messageTransmitter: string;
    tokenMessengerMinter: string;
    mtState: PresaleSharedObject;
    tmmState: PresaleSharedObject;
    usdcTreasury: PresaleSharedObject;
    /** The normalized USDC coin type. */
    usdcType: string;
    denyList: PresaleSharedObject;
    /**
     * CCTP V2's `stablecoin_handler` package and its `State`: the burn and the
     * mint go through it (Circle's V2 PTBs). Optional: without them nothing
     * is burned on Sui (no withdrawal to another chain).
     */
    stablecoinHandler?: string;
    handlerState?: PresaleSharedObject;
  }>;
}>;

/**
 * Why no identity is in force, as a fixed label that is safe to log:
 * - `missing`: `PRESALE_DEPLOYMENT_MANIFEST` is unset or blank;
 * - `malformed`: not JSON, or not exactly the schema above;
 * - `network_mismatch`: the chain identifier is not mainnet's genesis;
 * - `network_not_allowed`: the identity names a network other than mainnet;
 * - `fixture_identity`: production names a test or placeholder ID.
 */
export type PresaleIdentityProblem =
  | "missing"
  | "malformed"
  | "deployment_mismatch"
  | "network_mismatch"
  | "network_not_allowed"
  | "fixture_identity";

export type PresaleDeploymentState =
  | Readonly<{ status: "ready"; identity: PresaleRuntimeIdentity }>
  | Readonly<{ status: "unavailable"; reason: PresaleIdentityProblem }>;

/** The part of a Sui Core API client the identity check reads. */
export type ChainIdentifierNode = Readonly<{
  core: Readonly<{
    getChainIdentifier(options?: { signal?: AbortSignal }): Promise<{ chainIdentifier: string }>;
  }>;
}>;
