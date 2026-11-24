import { createHash } from "node:crypto";
import { ContractViolation } from "./decimal.ts";
import {
  compareKeys,
  decodeCursor,
  CursorError,
  type CursorShape,
  type CursorPosition,
} from "./cursor.ts";
import {
  parseLaunchSummary,
  type DiscoveryPage,
  type LaunchSummary,
} from "./discovery.ts";
import { readV1 } from "./v1.ts";
import type { MarketDataDependencies } from "../read-routing/market-data.ts";
import {
  normalizeBondingSearch,
  type BondingStage,
  type BondingSort,
} from "../launchpad-discovery/bonding.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

export type BondingSelection = Readonly<{
  stage: BondingStage;
  sort: BondingSort;
  q: string;
  creator?: string;
  accountCommitment?: string;
}>;
const SCALE = 10n ** 40n;
export function bondingCursor(selection: BondingSelection): CursorShape {
  const value = `v1:${selection.stage}:${selection.sort}:${selection.creator ?? ""}:${selection.q}:${selection.accountCommitment ?? ""}`;
  return {
    scope: `bonding:${createHash("sha256").update(value).digest("hex")}`,
    key: ["decimal"],
    tie: 3,
  };
}
export function bondingPosition(
  selection: BondingSelection,
  launch: LaunchSummary,
): CursorPosition | null {
  if (selection.stage === "graduated" && launch.lifecycle !== "migrated")
    return null;
  if (selection.stage === "bonding" && launch.lifecycle === "migrated")
    return null;
  let key: bigint;
  let cursor = launch.createdCursor;
  if (selection.sort === "progress") {
    const { quoteReserve, graduationTarget } = launch.economics.inputs;
    if (
      !["live", "migration_ready"].includes(launch.lifecycle) ||
      quoteReserve === null ||
      graduationTarget === null ||
      graduationTarget <= 0n
    )
      return null;
    key =
      ((quoteReserve < graduationTarget ? quoteReserve : graduationTarget) *
        SCALE) /
      graduationTarget;
  } else if (selection.stage === "graduated") {
    if (!launch.migration) return null;
    key = BigInt(launch.migration.timestampMs);
    cursor = launch.migration.cursor;
  } else key = BigInt(launch.createdAtMs);
  return {
    key: [key.toString()],
    tie: cursor
      .split(":")
      .slice(0, 3)
      .map((part) => part.padStart(20, "0")),
  };
}
export function parseBondingPage(
  selection: BondingSelection,
  value: unknown,
): DiscoveryPage {
  const body = value as { pools?: unknown; next_cursor?: unknown } | null;
  if (!body || !Array.isArray(body.pools) || body.pools.length > 100)
    throw new ContractViolation("pools", "must be a bounded page");
  const launches = body.pools.map((row, i) =>
    parseLaunchSummary(row, `pools[${i}]`),
  );
  const shape = bondingCursor(selection);
  const positions = launches.map((launch, i) => {
    const place = bondingPosition(selection, launch);
    if (!place)
      throw new ContractViolation(`pools[${i}]`, "is outside the selection");
    return place;
  });
  positions.slice(1).forEach((place, i) => {
    if (compareKeys(shape, positions[i], place) <= 0)
      throw new ContractViolation(`pools[${i + 1}]`, "is out of order");
  });
  const nextCursor = body.next_cursor;
  if (nextCursor !== null) {
    if (typeof nextCursor !== "string")
      throw new ContractViolation("next_cursor", "must be a token or null");
    let after: CursorPosition;
    try {
      after = decodeCursor(nextCursor, shape);
    } catch {
      throw new ContractViolation(
        "next_cursor",
        "has the wrong scope or shape",
      );
    }
    const last = positions.at(-1);
    if (!last || compareKeys(shape, last, after) !== 0)
      throw new ContractViolation("next_cursor", "must be the last position");
  }
  return {
    view: selection.stage === "graduated" ? "graduated" : "new",
    launches,
    nextCursor,
  };
}
type BondingRequest = Readonly<{
  limit?: string | null;
  cursor?: string | null;
  excludeQuote?: string;
}>;

export function bondingPath(
  selection: BondingSelection,
  request: BondingRequest,
): string {
  if (
    normalizeBondingSearch(selection.q) !== selection.q ||
    (selection.creator && !SUI_OBJECT_ID_PATTERN.test(selection.creator)) ||
    (selection.accountCommitment !== undefined &&
      (!selection.creator ||
        !/^[0-9a-f]{64}$/.test(selection.accountCommitment)))
  )
    throw new CursorError("invalid bonding selection");
  if (
    (selection.stage === "all" && !selection.creator) ||
    (selection.stage === "graduated" && selection.sort !== "newest")
  )
    throw new CursorError("invalid bonding selection");
  const limit = request.limit ?? "25";
  if (!/^[0-9]{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100)
    throw new CursorError("limit must be between 1 and 100");
  const params = new URLSearchParams({
    stage: selection.stage,
    sort: selection.sort,
    q: selection.q,
    limit,
  });
  if (selection.creator) params.set("creator", selection.creator);
  if (selection.accountCommitment)
    params.set("account_commitment", selection.accountCommitment);
  if (request.excludeQuote) params.set("exclude_quote", request.excludeQuote);
  if (request.cursor) {
    decodeCursor(request.cursor, bondingCursor(selection));
    params.set("cursor", request.cursor);
  }
  return `/v1/bonding?${params}`;
}
export function readBondingPage(
  selection: BondingSelection,
  request: BondingRequest,
  dependencies: MarketDataDependencies,
) {
  return readV1(
    "discovery-market-facts",
    bondingPath(selection, request),
    (body) => parseBondingPage(selection, body),
    dependencies,
  );
}
