import { z } from "zod";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";
import { launchCoinType } from "./contracts.ts";
import { financialIconUrlSchema } from "@blast/core/modules/social/contracts/financial-wire.ts";
import type { ExpectedDeployment } from "@blast/core/modules/launchpad-contract/provenance.ts";
import type { CoinPageRead } from "./contracts.ts";
import { decodeCoinWire } from "./wire.ts";

const creatorFeeAssignment = z.strictObject({
  provider: z.literal("x"),
  handleAtAssignment: z.string().regex(/^[A-Za-z0-9_]{1,15}$/),
});

export type LaunchPageDetails = Readonly<{
  tagline: string;
  iconUrl?: string;
  /** The original assignment, including after claim or reassignment. The handle is historical. */
  creatorFeeAssignment?: Readonly<z.infer<typeof creatorFeeAssignment>>;
  cover: Readonly<{ url: string; width: number; height: number }> | null;
  links: readonly Readonly<{ label: string; url: string }>[];
}>;

export function launchDetailsPath(launchId: string): string {
  return `/api/launchpad/launch-details/${encodeURIComponent(launchId)}`;
}

export type CoinPageTransfer = Readonly<{
  read: CoinPageRead;
  details?: LaunchPageDetails | null;
  /** R3-23: Blast checked who is behind this curve coin (`social_coin_trust`); sent only when true. */
  verifiedTeam?: true;
  browserMarket: Readonly<{ expected: ExpectedDeployment | null }> | null;
  explorer: Readonly<{ environment: string; explorer: Readonly<{ baseUrl: string }> }> | null;
}>;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid coin read response");
  return value as Record<string, unknown>;
}

export function parseLaunchDetails(raw: unknown): LaunchPageDetails | null {
  if (raw == null) return null;
  const details = record(raw);
  if (typeof details.tagline !== "string" || !Array.isArray(details.links)) throw new Error("Invalid launch details");
  if (details.iconUrl !== undefined && (typeof details.iconUrl !== "string" || !/^https:\/\//.test(details.iconUrl))) {
    throw new Error("Invalid launch logo");
  }
  if (details.creatorFeeAssignment !== undefined && !creatorFeeAssignment.safeParse(details.creatorFeeAssignment).success) {
    throw new Error("Invalid creator fee assignment");
  }
  for (const link of details.links) {
    const entry = record(link);
    if (typeof entry.label !== "string" || typeof entry.url !== "string" || !/^https?:\/\//.test(entry.url)) throw new Error("Invalid launch link");
  }
  if (details.cover !== null) {
    const cover = record(details.cover);
    if (
      typeof cover.url !== "string" ||
      !/^https:\/\//.test(cover.url) ||
      !Number.isSafeInteger(cover.width) ||
      !Number.isSafeInteger(cover.height) ||
      Number(cover.width) <= 0 ||
      Number(cover.height) <= 0
    )
      throw new Error("Invalid launch cover");
  }
  return raw as LaunchPageDetails;
}

/** The envelope's required keys, plus the optional `details` and `verifiedTeam` (sent only when true). */
function assertCoinEnvelope(value: Record<string, unknown>): void {
  const keys = Object.keys(value).filter((key) => key !== "details" && key !== "verifiedTeam").sort().join(",");
  if (keys !== "browserMarket,explorer,read" || ("verifiedTeam" in value && value.verifiedTeam !== true))
    throw new Error("Invalid coin read response");
}

/** The producer is typed; enforce the versioned envelope and requested identity here. */
export function parseCoinPageTransfer(text: string, launchId: string): CoinPageTransfer {
  return validateCoinPageTransfer(decodeCoinWire(text), launchId);
}

function validateCoinPageTransfer(raw: unknown, launchId: string): CoinPageTransfer {
  const value = record(raw);
  assertCoinEnvelope(value);
  parseLaunchDetails(value.details);
  const read = record(value.read);
  if (read.kind !== "coin" && read.kind !== "not-found") throw new Error("Invalid coin read response");
  if (read.kind === "coin") {
    const page = record(read.page);
    if (page.launchId !== launchId || typeof page.confirmed !== "boolean" || typeof page.tradable !== "boolean") throw new Error("Invalid coin read response");
  }
  if (value.browserMarket !== null) {
    const expected = record(value.browserMarket).expected;
    if (expected !== null) {
      const identity = record(expected);
      if (identity.network !== "mainnet" || typeof identity.deployment !== "string" || !/^[a-f0-9]{64}$/.test(identity.deployment)) throw new Error("Invalid coin read response");
    }
  }
  if (value.explorer !== null) {
    const explorer = record(value.explorer);
    if (typeof explorer.environment !== "string" || typeof record(explorer.explorer).baseUrl !== "string") throw new Error("Invalid coin read response");
  }
  return value as CoinPageTransfer;
}

const indexedId = z.string().regex(SUI_OBJECT_ID_PATTERN);
const presaleAlias = z.object({ kind: z.literal("presale"), presaleId: indexedId }).strict();
export type PresalePageAlias = Readonly<z.infer<typeof presaleAlias>>;

export function parseCoinObjectPageTransfer(text: string, objectId: string) {
  const value = record(decodeCoinWire(text));
  if (value.kind === "presale") {
    const alias = presaleAlias.parse(value);
    if (alias.presaleId !== objectId) {
      throw new Error("Invalid presale alias response");
    }
    return alias;
  }
  return { kind: "launch", launchId: objectId, transfer: validateCoinPageTransfer(value, objectId) } as const;
}

const typeIdentity = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("launch"), coinType: z.string(), launchId: indexedId }),
  z.object({ kind: z.literal("presale"), coinType: z.string(), presaleId: indexedId }),
  z.object({ kind: z.literal("generic"), coinType: z.string(), name: z.string().min(1).max(256), symbol: z.string().min(1).max(128), iconUrl: financialIconUrlSchema.optional() }),
  z.object({ kind: z.literal("not-found"), coinType: z.string() }),
]);

export type CoinTypePageIdentity = Readonly<z.infer<typeof typeIdentity>>;
export type CoinTypePageTransfer =
  | Exclude<CoinTypePageIdentity, { kind: "launch" }>
  | (Extract<CoinTypePageIdentity, { kind: "launch" }> & Readonly<{ transfer: CoinPageTransfer }>);

export function parseCoinTypePageTransfer(text: string, coinType: string): CoinTypePageTransfer {
  const raw = record(decodeCoinWire(text));
  const identity = typeIdentity.parse(raw);
  if (identity.coinType !== coinType) throw new Error("Invalid coin type response");
  if (identity.kind !== "launch") return identity;
  const transfer = validateCoinPageTransfer(raw.transfer, identity.launchId);
  if (transfer.read.kind === "coin") {
    const actualType = launchCoinType(transfer.read.page);
    if (actualType !== null && actualType !== coinType) throw new Error("Invalid launch coin type");
  }
  return { ...identity, transfer };
}
