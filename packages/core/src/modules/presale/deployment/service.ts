import { deploymentIdentity } from "../../../lib/config/deployment-identity.ts";
import { z } from "zod";
import { createHash } from "node:crypto";

import {
  BLAST_DEPLOYMENTS,
  deploymentFingerprint,
  presaleDeployment,
} from "@interest-protocol/blast-sdk/deployments";
import {
  normalizePresaleDeployment,
  type PresaleDeployment,
} from "@interest-protocol/blast-sdk/presale";
import {
  isValidStructTag,
  isValidSuiObjectId,
  isValidTransactionDigest,
  normalizeStructTag,
  normalizeSuiObjectId,
} from "@mysten/sui/utils";

import { expectedDeployment } from "../../launchpad-contract/provenance.ts";
import { recordPresaleMetric } from "../redaction/redaction.ts";
import { PresaleRouteError } from "../route-kit/errors.ts";
import type {
  ChainIdentifierNode,
  PresaleDeploymentState,
  PresaleIdentityProblem,
  PresaleNetwork,
  PresaleRuntimeIdentity,
  PresaleSharedObject,
} from "./contracts.ts";

type Environment = Readonly<Record<string, string | undefined>>;
type JsonRecord = Record<string, unknown>;

/** Mainnet's genesis checkpoint digest as the Core API reports it (SDK `deployments/registry.ts`). */
const SUI_MAINNET_GENESIS = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S";
const commitSchema = z.string().regex(/^[0-9a-f]{40}$/);
const objectIdSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{1,64}$/)
  .transform((value) => normalizeSuiObjectId(value.toLowerCase()))
  .refine((value) => isValidSuiObjectId(value) && BigInt(value) !== 0n);
const u64Schema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,19})$/)
  .pipe(z.string().refine((value) => BigInt(value) <= U64_MAX));
const digestSchema = z.string().refine(isValidTransactionDigest);
const structTagSchema = z.string().refine(isValidStructTag);
const U64_MAX = (1n << 64n) - 1n;

/**
 * The SDK's own test manifest IDs, sha256("blast-sdk-nonprod-<n>") for n below
 * 12 (SDK `deployments/identity.ts`, which does not export the set). With every
 * ID below 2^64 they are what production refuses as a test identity.
 */
const SDK_FIXTURE_IDS: ReadonlySet<string> = new Set(
  Array.from(
    { length: 12 },
    (_, n) => `0x${createHash("sha256").update(`blast-sdk-nonprod-${n}`).digest("hex")}`,
  ),
);

/** The labels of the web's own fixture identity (`fixtures.ts`), one object ID each. */
export const PRESALE_FIXTURE_ID_LABELS = [
  "presale-package",
  "package-version",
  "venue-config",
  "creation-policy",
  "fee-policy",
  "admin-package",
  "admin-acl",
  "cetus-global-config",
  "cetus-pools",
  "cetus-burn-manager",
  "bluefin-global-config",
  "aftermath-vendor-package",
  "aftermath-pool-registry",
  "aftermath-dao-fee-version",
] as const;

export function presaleFixtureObjectId(label: (typeof PRESALE_FIXTURE_ID_LABELS)[number]): string {
  return `0x${createHash("sha256").update(`presale-identity-fixture-${label}`).digest("hex")}`;
}

/** The web's fixture IDs: production refuses them even under a mainnet label. */
const WEB_FIXTURE_IDS: ReadonlySet<string> = new Set(
  PRESALE_FIXTURE_ID_LABELS.map(presaleFixtureObjectId),
);

class Malformed extends Error {
  readonly problem: PresaleIdentityProblem;
  constructor(problem: PresaleIdentityProblem = "malformed") {
    super(problem);
    this.problem = problem;
  }
}

function exact(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): JsonRecord {
  const shape = Object.fromEntries([
    ...required.map((key) => [key, z.unknown().nonoptional()]),
    ...optional.map((key) => [key, z.unknown().optional()]),
  ]);
  const parsed = z.strictObject(shape).safeParse(value);
  if (!parsed.success) throw new Malformed();
  return parsed.data;
}

function objectId(value: unknown): string {
  const parsed = objectIdSchema.safeParse(value);
  if (!parsed.success) throw new Malformed();
  return parsed.data;
}

function u64(value: unknown, positive: boolean): string {
  const parsed = u64Schema.safeParse(value);
  if (!parsed.success || (positive && parsed.data === "0")) throw new Malformed();
  return parsed.data;
}

function sharedObject(value: unknown): PresaleSharedObject {
  const record = exact(value, ["objectId", "initialSharedVersion"]);
  return Object.freeze({
    objectId: objectId(record.objectId),
    initialSharedVersion: u64(record.initialSharedVersion, true),
  });
}

type Venues = PresaleRuntimeIdentity["venues"];

function localPresaleDeployment(value: unknown, aftermath: Venues["aftermath"]): PresaleDeployment {
  const record = exact(value, [
    "packageId", "originalPackageId", "packageVersion", "packageAdmin",
    "creationPolicy", "feePolicy", "presaleRegistry", "core", "admin",
    "partners", "vault", "migrators", "vestingPackageId",
  ]);
  try {
    return normalizePresaleDeployment({
      ...(record as PresaleDeployment),
      ...(aftermath ? {
        aftermathDaoPresale: {
          packageId: aftermath.vendorPackageId,
          originalPackageId: aftermath.vendorPackageId,
          aftermath: { poolRegistry: aftermath.poolRegistry, daoFeeVersion: aftermath.daoFeeVersion },
        },
      } : {}),
    });
  } catch {
    throw new Malformed();
  }
}

function aftermathVenue(value: unknown): NonNullable<Venues["aftermath"]> {
  const record = exact(value, ["vendorPackageId", "poolRegistry", "daoFeeVersion"]);
  return Object.freeze({
    vendorPackageId: objectId(record.vendorPackageId),
    poolRegistry: sharedObject(record.poolRegistry),
    daoFeeVersion: sharedObject(record.daoFeeVersion),
  });
}

function venues(value: unknown): Venues {
  const record = exact(value, [], ["cetus", "bluefin", "aftermath"]);
  const result: {
    cetus?: Venues["cetus"];
    bluefin?: Venues["bluefin"];
    aftermath?: Venues["aftermath"];
  } = {};
  if (record.cetus !== undefined) {
    const cetus = exact(record.cetus, ["globalConfig", "pools", "burnManager"]);
    result.cetus = Object.freeze({
      globalConfig: sharedObject(cetus.globalConfig),
      pools: sharedObject(cetus.pools),
      burnManager: sharedObject(cetus.burnManager),
    });
  }
  if (record.bluefin !== undefined) {
    result.bluefin = Object.freeze({
      globalConfig: sharedObject(exact(record.bluefin, ["globalConfig"]).globalConfig),
    });
  }
  if (record.aftermath !== undefined) result.aftermath = aftermathVenue(record.aftermath);
  return Object.freeze(result);
}

function cctp(value: unknown): NonNullable<PresaleRuntimeIdentity["cctp"]> {
  const record = exact(
    value,
    [
      "messageTransmitter",
      "tokenMessengerMinter",
      "mtState",
      "tmmState",
      "usdcTreasury",
      "usdcType",
      "denyList",
    ],
    ["stablecoinHandler", "handlerState"],
  );
  const coinType = structTagSchema.safeParse(record.usdcType);
  if (!coinType.success) throw new Malformed();
  // The V2 stablecoin handler comes as a pair: its package and its `State`.
  if ((record.stablecoinHandler === undefined) !== (record.handlerState === undefined))
    throw new Malformed();
  return Object.freeze({
    messageTransmitter: objectId(record.messageTransmitter),
    tokenMessengerMinter: objectId(record.tokenMessengerMinter),
    mtState: sharedObject(record.mtState),
    tmmState: sharedObject(record.tmmState),
    usdcTreasury: sharedObject(record.usdcTreasury),
    usdcType: normalizeStructTag(coinType.data),
    denyList: sharedObject(record.denyList),
    ...(record.stablecoinHandler === undefined
      ? {}
      : {
          stablecoinHandler: objectId(record.stablecoinHandler),
          handlerState: sharedObject(record.handlerState),
        }),
  });
}

/** The presale runs on mainnet only: any other named network is refused, in every environment. */
function network(value: unknown): PresaleNetwork {
  if (typeof value !== "string") throw new Malformed();
  if (value !== "mainnet") throw new Malformed("network_not_allowed");
  return value;
}

/** The chain identifier must be mainnet's genesis. */
function chainIdentifier(value: unknown): string {
  const parsed = digestSchema.safeParse(value);
  if (!parsed.success) throw new Malformed();
  if (parsed.data !== SUI_MAINNET_GENESIS) throw new Malformed("network_mismatch");
  return parsed.data;
}

function commit(value: unknown): string {
  const parsed = commitSchema.safeParse(value);
  if (!parsed.success) throw new Malformed();
  return parsed.data;
}

/** Package and object IDs that must be published ones; system objects such as the deny list are exempt. */
function identityIds(identity: PresaleRuntimeIdentity): string[] {
  const { presale, venues: venueObjects, cctp: bridge } = identity;
  return [
    presale.packageId,
    presale.originalPackageId,
    presale.packageVersion.objectId,
    presale.packageAdmin.objectId,
    presale.presaleRegistry.objectId,
    presale.creationPolicy.objectId,
    presale.feePolicy.objectId,
    presale.admin.packageId,
    presale.admin.acl.objectId,
    ...[venueObjects.cetus, venueObjects.bluefin].flatMap((venue) =>
      Object.values(venue ?? {}).map((object) => object.objectId),
    ),
    // Aftermath's own objects are the SDK's documented mainnet defaults or the manifest's; the vendor is ours.
    ...(venueObjects.aftermath
      ? [
          venueObjects.aftermath.vendorPackageId,
          venueObjects.aftermath.poolRegistry.objectId,
          venueObjects.aftermath.daoFeeVersion.objectId,
        ]
      : []),
    ...(bridge
      ? [
          bridge.messageTransmitter,
          bridge.tokenMessengerMinter,
          bridge.mtState.objectId,
          bridge.tmmState.objectId,
          bridge.usdcTreasury.objectId,
          ...(bridge.stablecoinHandler && bridge.handlerState
            ? [bridge.stablecoinHandler, bridge.handlerState.objectId]
            : []),
        ]
      : []),
  ];
}

function isFixtureId(id: string): boolean {
  return BigInt(id) < 1n << 64n || SDK_FIXTURE_IDS.has(id) || WEB_FIXTURE_IDS.has(id);
}

/**
 * Parses an identity, failing closed. Production (`production: true`) takes
 * mainnet only and refuses any test or placeholder ID: an ID below 2^64, one
 * of the SDK's own test manifest IDs, or one of the web fixture's IDs.
 */
export function parsePresaleRuntimeIdentity(
  value: unknown,
  options: Readonly<{ production: boolean }>,
): PresaleRuntimeIdentity {
  const record = exact(
    value,
    [
      "schemaVersion",
      "network",
      "chainIdentifier",
      "contractsCommit",
      "sdkCommit",
      "presale",
      "publishCheckpoint",
      "venues",
    ],
    ["cctp"],
  );
  if (!z.literal(2).safeParse(record.schemaVersion).success) throw new Malformed();
  const venueObjects = venues(record.venues);
  const identity: PresaleRuntimeIdentity = Object.freeze({
    schemaVersion: 2,
    network: network(record.network),
    chainIdentifier: chainIdentifier(record.chainIdentifier),
    contractsCommit: commit(record.contractsCommit),
    sdkCommit: commit(record.sdkCommit),
    presale: Object.freeze(localPresaleDeployment(record.presale, venueObjects.aftermath)),
    publishCheckpoint: u64(record.publishCheckpoint, false),
    venues: venueObjects,
    ...(record.cctp === undefined ? {} : { cctp: cctp(record.cctp) }),
  });
  if (options.production && identityIds(identity).some(isFixtureId)) throw new Malformed("fixture_identity");
  return identity;
}

/**
 * Production rules apply on Vercel production and in a worker's production
 * selection, as for the database endpoints (`database/topology.ts`).
 */
export function isPresaleProduction(environment: Environment): boolean {
  return deploymentIdentity(environment).production;
}

/** Selects the published stack in production and when a deployment is configured. */
export function readPresaleDeploymentIdentity(
  environment: Environment = process.env,
): PresaleDeploymentState {
  try {
    const selected = expectedDeployment(environment);
    if (selected) {
      const manifest = BLAST_DEPLOYMENTS[selected.network];
      if (!manifest || deploymentFingerprint(manifest) !== selected.deployment) {
        return Object.freeze({ status: "unavailable", reason: "deployment_mismatch" });
      }
      const { cetus, bluefin, aftermath } = manifest.sharedObjects;
      const ref = (value: Readonly<{ objectId: string; initialSharedVersion: number | string }>) => ({
        objectId: value.objectId,
        initialSharedVersion: String(value.initialSharedVersion),
      });
      const vendor = manifest.packages.aftermathDaoPresale;
      const identity: PresaleRuntimeIdentity = Object.freeze({
        schemaVersion: 2,
        manifest,
        network: manifest.network,
        chainIdentifier: manifest.chainIdentifier,
        contractsCommit: manifest.source.contractsCommit,
        sdkCommit: manifest.sdk.commit,
        presale: Object.freeze(presaleDeployment(manifest)),
        venues: Object.freeze({
          ...(cetus ? { cetus: { globalConfig: ref(cetus.config), pools: ref(cetus.pools), burnManager: ref(cetus.burnManager) } } : {}),
          ...(bluefin ? { bluefin: { globalConfig: ref(bluefin.config) } } : {}),
          ...(aftermath && vendor ? { aftermath: {
            vendorPackageId: vendor.packageId,
            poolRegistry: ref(aftermath.poolRegistry),
            daoFeeVersion: ref(aftermath.daoFeeVersion),
          } } : {}),
        }),
      });
      return Object.freeze({ status: "ready", identity });
    }
    const raw = environment.PRESALE_DEPLOYMENT_MANIFEST?.trim();
    if (isPresaleProduction(environment) || !raw) {
      return Object.freeze({ status: "unavailable", reason: "missing" });
    }
    const identity = parsePresaleRuntimeIdentity(JSON.parse(raw) as unknown, { production: false });
    return Object.freeze({ status: "ready", identity });
  } catch (error) {
    return Object.freeze({
      status: "unavailable",
      reason: error instanceof Malformed ? error.problem : "malformed",
    });
  }
}

export type PresaleDeploymentGate = Readonly<{
  /** The parsed identity, or `deployment_unavailable`. It does not authorize signing. */
  identity(): PresaleRuntimeIdentity;
  /**
   * The identity once the node reports its chain identifier: required before
   * serving identity-dependent data, sponsoring or signing. No identity, no
   * node, an unreachable node, or one that does not answer within the node
   * timeout is `deployment_unavailable`; another chain is `deployment_mismatch`.
   */
  authorize(options?: { signal?: AbortSignal }): Promise<PresaleRuntimeIdentity>;
  state: PresaleDeploymentState;
}>;

/** How long the gate waits for the node's chain identifier before answering `deployment_unavailable`. */
export const PRESALE_NODE_TIMEOUT_MS = 3_000;

/** Settles with `operation`, or rejects once `signal` aborts, whether or not the operation honours it. */
function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("aborted"));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * One process's identity gate: the identity is read once, and a node that
 * matched is remembered (a chain's genesis never changes). A mismatch, a
 * failed read or a timed-out read is never remembered, so every later call
 * checks again. Each node read is bounded by `nodeTimeoutMs`.
 */
export function createPresaleDeploymentGate(
  input: Readonly<{
    environment?: Environment;
    state?: PresaleDeploymentState;
    /** The configured Sui node, or null when none is configured. */
    node: () => Promise<ChainIdentifierNode | null>;
    /** Defaults to `PRESALE_NODE_TIMEOUT_MS`. */
    nodeTimeoutMs?: number;
  }>,
): PresaleDeploymentGate {
  const state = input.state ?? readPresaleDeploymentIdentity(input.environment ?? process.env);
  const nodeTimeoutMs = input.nodeTimeoutMs ?? PRESALE_NODE_TIMEOUT_MS;
  if (!z.number().int().safe().positive().safeParse(nodeTimeoutMs).success) {
    throw new TypeError("The presale node timeout must be a positive integer of milliseconds.");
  }
  let verifiedNode: ChainIdentifierNode | null = null;
  let reported = false;

  function identity(): PresaleRuntimeIdentity {
    if (state.status === "ready") return state.identity;
    if (!reported) {
      reported = true;
      recordPresaleMetric("presale.deployment", { outcome: "unavailable", reason: state.reason });
    }
    throw new PresaleRouteError("deployment_unavailable");
  }

  return Object.freeze({
    state,
    identity,
    async authorize(options = {}) {
      const current = identity();
      let node: ChainIdentifierNode | null;
      let reportedChain: string;
      const timeout = AbortSignal.timeout(nodeTimeoutMs);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      try {
        node = await untilAborted(input.node(), signal);
        if (!node) throw new Error("no node configured");
        if (node === verifiedNode) return current;
        reportedChain = (await untilAborted(node.core.getChainIdentifier({ signal }), signal))
          .chainIdentifier;
      } catch {
        recordPresaleMetric("presale.deployment", {
          outcome: "unavailable",
          reason: timeout.aborted
            ? "node_timeout"
            : options.signal?.aborted
              ? "caller_aborted"
              : "node_unavailable",
        });
        throw new PresaleRouteError("deployment_unavailable");
      }
      if (reportedChain !== current.chainIdentifier) {
        recordPresaleMetric("presale.deployment", {
          outcome: "mismatch",
          network: current.network,
        });
        throw new PresaleRouteError("deployment_mismatch");
      }
      verifiedNode = node;
      return current;
    },
  });
}
