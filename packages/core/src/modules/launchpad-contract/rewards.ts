import type { MarketDataDependencies } from "../read-routing/market-data.ts";
import { LAUNCH_PAGE, pageParams, type LaunchPageRequest } from "./activity.ts";
import { CursorError, EVENT_CURSOR, compareKeys, decodeCursor, type CursorShape } from "./cursor.ts";
import { ContractViolation, parseAtomic } from "./decimal.ts";
import type { RoutedRead } from "./read.ts";
import { readV1, type V1Answer } from "./v1.ts";
import { COIN_TYPE, SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

/**
 * The launchpad's rewards, creator, partner and policy reads of blast-infra's
 * `/v1` (its docs/api.md): their paths and page-token shapes. Each token is
 * bound to its list as blast-infra binds it, so a token of another list, or
 * of another launch, wallet or partner, is a CursorError before any read.
 *
 * | read                                              | token scope                       | tie-break           |
 * | ------------------------------------------------- | --------------------------------- | ------------------- |
 * | `/v1/launches/{launch_id}/rewards`                | none                              |                     |
 * | `/v1/launches/{launch_id}/reward-rounds`          | `launch_reward_rounds:<launch>`   | the round number    |
 * | `/v1/wallets/{address}/launch-rewards`            | `launch_rewards:<address>`        | creation position   |
 * | `/v1/wallets/{address}/vault-rewards`     | `vault_rewards:<address>` | payout position     |
 * | `/v1/wallets/{address}/launches`                  | `wallet_launches:<address>`       | creation position   |
 * | `/v1/partners`                                    | `partners`                        | the partner ID      |
 * | `/v1/partners/{partner_id}`                       | none                              |                     |
 * | `/v1/partners/{partner_id}/launches`              | `partner_launches:<partner>`      | creation position   |
 * | `/v1/launchpad/policy`                            | none                              |                     |
 * | `/v1/creator-claims?recipient=` or `?account=`    | `creator_claims:<kind>:<named>`   | creation position   |
 */

type Bounds = Readonly<{ default: number; max: number }>;

function canonical(value: string, name: string): string {
  if (!SUI_OBJECT_ID_PATTERN.test(value)) throw new CursorError(`${name} must be a canonical object id`);
  return value;
}

export function rewardRoundsCursor(launchId: string): CursorShape {
  return { scope: `launch_reward_rounds:${launchId}`, key: [], tie: 1 };
}

export function walletLaunchRewardsCursor(address: string): CursorShape {
  return { scope: `launch_rewards:${address}`, key: [], tie: 3 };
}

export function walletHolderRewardsCursor(address: string): CursorShape {
  return { scope: `vault_rewards:${address}`, key: [], tie: 3 };
}

export function walletLaunchesCursor(address: string): CursorShape {
  return { scope: `wallet_launches:${address}`, key: [], tie: 3 };
}

export const PARTNERS_CURSOR: CursorShape = Object.freeze({ scope: "partners", key: [], tie: 1 });

export function partnerLaunchesCursor(partnerId: string): CursorShape {
  return { scope: `partner_launches:${partnerId}`, key: [], tie: 3 };
}

export const LAUNCHPAD_POLICY_PATH = "/v1/launchpad/policy";

/**
 * Whom a creator-claims read names: a wallet address (`recipient=`), or a Blast account's 32-byte
 * commitment as 64 lowercase hex digits without `0x` (`account=`), as LP-16's commitment route
 * answers it.
 */
export type CreatorClaimsRecipient = Readonly<{ kind: "address"; address: string }> | Readonly<{ kind: "account"; commitment: string }>;

const ACCOUNT_COMMITMENT = /^[0-9a-f]{64}$/;

/** The recipient as blast-infra names it in the answer and the page token: the address, or the commitment's hex. */
function namedRecipient(recipient: CreatorClaimsRecipient): string {
  if (recipient.kind === "address") return canonical(recipient.address, "recipient");
  if (!ACCOUNT_COMMITMENT.test(recipient.commitment)) throw new CursorError("account must be 64 lowercase hex digits");
  return recipient.commitment;
}

export function creatorClaimsCursor(recipient: CreatorClaimsRecipient): CursorShape {
  return { scope: `creator_claims:${recipient.kind}:${namedRecipient(recipient)}`, key: [], tie: 3 };
}

export function launchRewardsPath(launchId: string): string {
  return `/v1/launches/${canonical(launchId, "launch_id")}/rewards`;
}

export function rewardRoundsPath(launchId: string, request: LaunchPageRequest, bounds: Bounds = LAUNCH_PAGE): string {
  const params = pageParams(request, rewardRoundsCursor(canonical(launchId, "launch_id")), bounds);
  return `/v1/launches/${launchId}/reward-rounds?${params.toString()}`;
}

export function walletLaunchRewardsPath(address: string, request: LaunchPageRequest, bounds: Bounds = LAUNCH_PAGE): string {
  const params = pageParams(request, walletLaunchRewardsCursor(canonical(address, "address")), bounds);
  return `/v1/wallets/${address}/launch-rewards?${params.toString()}`;
}

export function walletHolderRewardsPath(address: string, request: LaunchPageRequest, bounds: Bounds = LAUNCH_PAGE): string {
  const params = pageParams(request, walletHolderRewardsCursor(canonical(address, "address")), bounds);
  return `/v1/wallets/${address}/vault-rewards?${params.toString()}`;
}

export function walletLaunchesPath(address: string, request: LaunchPageRequest, bounds: Bounds = LAUNCH_PAGE): string {
  const params = pageParams(request, walletLaunchesCursor(canonical(address, "address")), bounds);
  return `/v1/wallets/${address}/launches?${params.toString()}`;
}

/** The launches whose creator caps `recipient` can still claim: `recipient=` for an address, `account=` for a commitment. */
export function creatorClaimsPath(recipient: CreatorClaimsRecipient, request: LaunchPageRequest, bounds: Bounds = LAUNCH_PAGE): string {
  const params = new URLSearchParams({ [recipient.kind === "address" ? "recipient" : "account"]: namedRecipient(recipient) });
  for (const [key, value] of pageParams(request, creatorClaimsCursor(recipient), bounds)) params.set(key, value);
  return `/v1/creator-claims?${params.toString()}`;
}

export function partnersPath(request: LaunchPageRequest, bounds: Bounds = LAUNCH_PAGE): string {
  return `/v1/partners?${pageParams(request, PARTNERS_CURSOR, bounds).toString()}`;
}

export function partnerPath(partnerId: string): string {
  return `/v1/partners/${canonical(partnerId, "partner_id")}`;
}

export function partnerLaunchesPath(partnerId: string, request: LaunchPageRequest, bounds: Bounds = LAUNCH_PAGE): string {
  const params = pageParams(request, partnerLaunchesCursor(canonical(partnerId, "partner_id")), bounds);
  return `/v1/partners/${partnerId}/launches?${params.toString()}`;
}

// --- A launch's rewards -----------------------------------------------------------------------------

/** One party's figures in one coin: everything it accrued, what it claimed, and what remains. */
export type Share = Readonly<{ accrued: bigint; claimed: bigint; outstanding: bigint }>;
/** A party of the curve's ledger: Meme, Quote and SUI (only Blast holds SUI: the creation fee). */
export type CurveParty = Readonly<{ meme: Share; quote: Share; sui: Share }>;
/** A party of the vault's ledger: Meme and Quote; the vault holds no SUI. */
export type VaultParty = Readonly<{ meme: Share; quote: Share }>;
export type Pair = Readonly<{ meme: bigint; quote: bigint }>;

export type CurvePartnerPaid = Readonly<{ partnerId: string; paidMeme: bigint; paidQuote: bigint; paidSui: bigint }>;
export type VaultPartnerPaid = Readonly<{ partnerId: string; paidMeme: bigint; paidQuote: bigint }>;

/** The migration vault's ledger: its LP-fee collections, each share, and what they returned to holders. */
export type VaultRewards = Readonly<{
  vaultId: string;
  collected: Pair;
  creator: VaultParty;
  protocol: VaultParty;
  partner: VaultPartnerPaid | null;
  /** What the split set aside for holders and the coin: auto-liquidity, rewards, burn, recipients. */
  returned: Readonly<{ autoLp: Pair; rewards: Pair; burn: Pair; recipients: Pair }>;
  /** What the vault has put to work: rounds reserved, liquidity added, coins bought back and burned. */
  deployed: Readonly<{ rewardsPublished: Pair; autoLpAdded: Pair; buyback: Readonly<{ memeBurned: bigint; quoteSpent: bigint }> }>;
}>;

/**
 * A launch's fees in two ledgers (blast-infra `GET /v1/launches/{launch_id}/rewards`): its
 * curve's, from creation to migration, and its migration vault's, from migration on (`null`
 * before).
 */
export type LaunchRewards = Readonly<{
  launchId: string;
  coin: string;
  quote: string;
  creator: CurveParty;
  protocol: CurveParty;
  partner: CurvePartnerPaid | null;
  vault: VaultRewards | null;
}>;

function object(value: unknown, field: string, keys: readonly string[], ignored: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ContractViolation(field, "must be an object");
  const found = value as Record<string, unknown>;
  const extra = Object.keys(found).find((key) => !keys.includes(key) && !ignored.includes(key));
  if (extra) throw new ContractViolation(`${field}.${extra}`, "is not in the contract");
  const missing = keys.find((key) => !(key in found));
  if (missing) throw new ContractViolation(`${field}.${missing}`, "is required");
  return found;
}

function text(value: unknown, pattern: RegExp, field: string, what: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new ContractViolation(field, `must be ${what}`);
  return value;
}

/** A share; claimed never exceeds accrued, and outstanding is their difference. */
function share(value: unknown, field: string): Share {
  const found = object(value, field, ["accrued", "claimed", "outstanding"]);
  const accrued = parseAtomic(found.accrued, `${field}.accrued`, 128);
  const claimed = parseAtomic(found.claimed, `${field}.claimed`, 128);
  const outstanding = parseAtomic(found.outstanding, `${field}.outstanding`, 128);
  if (claimed > accrued || outstanding !== accrued - claimed) throw new ContractViolation(field, "is accrued less claimed");
  return { accrued, claimed, outstanding };
}

function pair(value: unknown, field: string, keys: readonly [string, string] = ["meme", "quote"]): Pair {
  const found = object(value, field, keys);
  return { meme: parseAtomic(found[keys[0]], `${field}.${keys[0]}`, 128), quote: parseAtomic(found[keys[1]], `${field}.${keys[1]}`, 128) };
}

function curveParty(value: unknown, field: string): CurveParty {
  const found = object(value, field, ["meme", "quote", "sui"]);
  return { meme: share(found.meme, `${field}.meme`), quote: share(found.quote, `${field}.quote`), sui: share(found.sui, `${field}.sui`) };
}

function vaultParty(value: unknown, field: string): VaultParty {
  const found = object(value, field, ["meme", "quote"]);
  return { meme: share(found.meme, `${field}.meme`), quote: share(found.quote, `${field}.quote`) };
}

const ZERO_SHARE: Share = { accrued: 0n, claimed: 0n, outstanding: 0n };

function protocolLedger(value: unknown, originId: string, kind: "launch" | "vault", field: string) {
  if (value === null) {
    return { shares: { meme: ZERO_SHARE, quote: ZERO_SHARE, sui: ZERO_SHARE }, partner: null };
  }
  const ledger = object(value, field, ["package_witness", "origin_id", "kind", "partner_id", "accrued", "treasury_paid", "partner_paid", "held"]);
  if (ledger.origin_id !== originId || ledger.kind !== kind) throw new ContractViolation(field, "must belong to the requested ledger");
  const keys = ["meme", "quote", "sui"];
  const accrued = object(ledger.accrued, `${field}.accrued`, keys);
  const treasury = object(ledger.treasury_paid, `${field}.treasury_paid`, keys);
  const partner = object(ledger.partner_paid, `${field}.partner_paid`, keys);
  const held = object(ledger.held, `${field}.held`, keys);
  function balance(coin: "meme" | "quote" | "sui") {
    const total = parseAtomic(accrued[coin], `${field}.accrued.${coin}`, 128);
    const paid = parseAtomic(partner[coin], `${field}.partner_paid.${coin}`, 128);
    const claimed = parseAtomic(treasury[coin], `${field}.treasury_paid.${coin}`, 128) + paid;
    const outstanding = parseAtomic(held[coin], `${field}.held.${coin}`, 128);
    if (claimed + outstanding !== total) throw new ContractViolation(`${field}.${coin}`, "payments plus held must equal accrued");
    return { share: { accrued: total, claimed, outstanding }, paid };
  }
  const meme = balance("meme");
  const quote = balance("quote");
  const sui = balance("sui");
  return {
    shares: { meme: meme.share, quote: quote.share, sui: sui.share },
    partner: ledger.partner_id === null ? null : {
      partnerId: text(ledger.partner_id, SUI_OBJECT_ID_PATTERN, `${field}.partner_id`, "an object id"),
      paidMeme: meme.paid,
      paidQuote: quote.paid,
      paidSui: sui.paid,
    },
  };
}

function parseVault(value: unknown, launchId: string): VaultRewards {
  const vault = object(value, "vault",
    ["vault_id", "origin", "collected", "owner", "auto_lp", "holder_rewards", "burn", "address", "protocol_fees"],
    ["package_witness", "venue", "meme", "quote", "pool_id", "position_id", "auto_lp_position_id", "liquidity",
      "terms", "fee_split", "protocol_bps", "round_publication", "next_round", "residuals", "created"],
  );
  const origin = object(vault.origin, "vault.origin", ["id", "kind"]);
  if (origin.id !== launchId || origin.kind !== "launch") throw new ContractViolation("vault.origin", "must belong to the requested launch");
  const vaultId = text(vault.vault_id, SUI_OBJECT_ID_PATTERN, "vault.vault_id", "an object id");
  const collected = object(vault.collected, "vault.collected", ["gross", "protocol"]);
  const owner = object(vault.owner, "vault.owner", ["accrued", "claimed"]);
  const accrued = pair(owner.accrued, "vault.owner.accrued");
  const claimed = pair(owner.claimed, "vault.owner.claimed");
  const ownerShare = (coin: "meme" | "quote"): Share => {
    if (claimed[coin] > accrued[coin]) throw new ContractViolation(`vault.owner.${coin}`, "claimed must not exceed accrued");
    return { accrued: accrued[coin], claimed: claimed[coin], outstanding: accrued[coin] - claimed[coin] };
  };
  const autoLp = object(vault.auto_lp, "vault.auto_lp", ["accrued", "added", "pending"]);
  const rewards = object(vault.holder_rewards, "vault.holder_rewards", ["accrued", "published", "returned"]);
  const burn = object(vault.burn, "vault.burn", ["accrued", "meme_burned", "quote_spent", "quote_pending"]);
  const ledger = protocolLedger(vault.protocol_fees, vaultId, "vault", "vault.protocol_fees");
  return {
    vaultId,
    collected: pair(collected.gross, "vault.collected.gross"),
    creator: { meme: ownerShare("meme"), quote: ownerShare("quote") },
    protocol: { meme: ledger.shares.meme, quote: ledger.shares.quote },
    partner: ledger.partner,
    returned: {
      autoLp: pair(autoLp.accrued, "vault.auto_lp.accrued"),
      rewards: pair(rewards.accrued, "vault.holder_rewards.accrued"),
      burn: pair(burn.accrued, "vault.burn.accrued"),
      recipients: pair(vault.address, "vault.address"),
    },
    deployed: {
      rewardsPublished: pair(rewards.published, "vault.holder_rewards.published"),
      autoLpAdded: pair(autoLp.added, "vault.auto_lp.added"),
      buyback: {
        memeBurned: parseAtomic(burn.meme_burned, "vault.burn.meme_burned", 128),
        quoteSpent: parseAtomic(burn.quote_spent, "vault.burn.quote_spent", 128),
      },
    },
  };
}

/** Reads both fee ledgers and checks they belong to the requested launch. */
export function parseLaunchRewards(launchId: string, body: unknown): LaunchRewards {
  const answer = object(
    body,
    "body",
    ["launch_id", "coin", "quote", "creator", "protocol", "partner", "allocations", "expected_vault_id", "vault", "quote_usd"],
    ["provenance"],
  );
  if (answer.launch_id !== launchId) throw new ContractViolation("launch_id", "must be the requested launch");
  if (!Array.isArray(answer.allocations)) throw new ContractViolation("allocations", "must be a list");
  const protocol = protocolLedger(answer.protocol, launchId, "launch", "protocol");
  const partner = answer.partner === null ? null : object(answer.partner, "partner", ["partner_id", "paid"]);
  const paid = partner?.paid == null ? null : object(partner.paid, "partner.paid", ["meme", "quote", "sui"]);
  const vault = answer.vault === null ? null : parseVault(answer.vault, launchId);
  if (vault && answer.expected_vault_id !== vault.vaultId) throw new ContractViolation("expected_vault_id", "must match the vault");
  return {
    launchId,
    coin: text(answer.coin, COIN_TYPE, "coin", "a canonical coin type"),
    quote: text(answer.quote, COIN_TYPE, "quote", "a canonical coin type"),
    creator: curveParty(answer.creator, "creator"),
    protocol: protocol.shares,
    partner: partner && {
      partnerId: text(partner.partner_id, SUI_OBJECT_ID_PATTERN, "partner.partner_id", "an object id"),
      paidMeme: paid ? parseAtomic(paid.meme, "partner.paid.meme", 128) : 0n,
      paidQuote: paid ? parseAtomic(paid.quote, "partner.paid.quote", 128) : 0n,
      paidSui: paid ? parseAtomic(paid.sui, "partner.paid.sui", 128) : 0n,
    },
    vault,
  };
}

/** Reads a launch's rewards from blast-infra, validated, with its provenance. */
export function readLaunchRewards(launchId: string, dependencies: MarketDataDependencies): Promise<RoutedRead<V1Answer<LaunchRewards>>> {
  return readV1("market", launchRewardsPath(launchId), (body) => parseLaunchRewards(launchId, body), dependencies);
}

// --- A wallet's launch rewards and holder rewards ---------------------------------------------------

const LAUNCH_LIFECYCLES = ["opening_round", "live", "migration_ready", "migrated"] as const;
const UNSIGNED = /^(0|[1-9][0-9]*)$/;
const DIGEST = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PAGE_CEILING = 100;

function decimals(value: unknown, field: string): number {
  const parsed = Number(text(value, UNSIGNED, field, "decimals"));
  if (parsed > 38) throw new ContractViolation(field, "is at most 38");
  return parsed;
}

function nullableDecimals(value: unknown, field: string): number | null {
  return value === null ? null : decimals(value, field);
}

/** A page's next cursor: a token of `shape`, or null. */
function pageCursor(value: unknown, shape: CursorShape): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new ContractViolation("next_cursor", "must be a page token or null");
  try {
    decodeCursor(value, shape);
  } catch (error) {
    if (error instanceof CursorError) throw new ContractViolation("next_cursor", error.message);
    throw error;
  }
  return value;
}

/** A launch whose creator fees the wallet can claim, with its creator share in both ledgers. */
export type WalletLaunchReward = Readonly<{
  launchId: string;
  coin: string;
  quote: string;
  lifecycle: (typeof LAUNCH_LIFECYCLES)[number];
  name: string | null;
  symbol: string | null;
  iconUrl: string | null;
  memeDecimals: number;
  /** Null for a Quote the quote table does not list. */
  quoteDecimals: number | null;
  /** How the wallet is entitled: it owns the launch's current `CurveFeeCap`, or no cap exists yet and it is the ticket's creator. */
  entitledBy: "curve_fee_cap" | "creator";
  curve: VaultParty;
  vault: VaultParty | null;
  /** What remains to claim across both ledgers: they are the same coins. */
  outstanding: Pair;
}>;

export type WalletLaunchRewardsPage = Readonly<{ address: string; launches: readonly WalletLaunchReward[]; nextCursor: string | null }>;

function parseWalletLaunchReward(value: unknown, field: string): WalletLaunchReward {
  const row = object(value, field, [
    "launch_id", "coin", "quote", "lifecycle", "metadata", "meme_decimals", "quote_decimals", "creator", "entitled_by", "curve", "vault",
    "outstanding",
  ]);
  if (!LAUNCH_LIFECYCLES.includes(row.lifecycle as WalletLaunchReward["lifecycle"])) {
    throw new ContractViolation(`${field}.lifecycle`, "is not a launch lifecycle");
  }
  if (row.entitled_by !== "curve_fee_cap" && row.entitled_by !== "creator") throw new ContractViolation(`${field}.entitled_by`, "is unknown");
  if (row.creator !== null) text(row.creator, SUI_OBJECT_ID_PATTERN, `${field}.creator`, "an address or null");
  const metadata = row.metadata === null ? null : object(row.metadata, `${field}.metadata`, ["name", "symbol", "description", "icon_url"]);
  const curve = vaultParty(row.curve, `${field}.curve`);
  const vault = row.vault === null ? null : vaultParty(row.vault, `${field}.vault`);
  const outstanding = pair(row.outstanding, `${field}.outstanding`);
  const expected = {
    meme: curve.meme.outstanding + (vault?.meme.outstanding ?? 0n),
    quote: curve.quote.outstanding + (vault?.quote.outstanding ?? 0n),
  };
  if (outstanding.meme !== expected.meme || outstanding.quote !== expected.quote) {
    throw new ContractViolation(`${field}.outstanding`, "is the curve's and the vault's outstanding together");
  }
  const string = (key: string) => (metadata && typeof metadata[key] === "string" ? (metadata[key] as string) : null);
  return {
    launchId: text(row.launch_id, SUI_OBJECT_ID_PATTERN, `${field}.launch_id`, "an object id"),
    coin: text(row.coin, COIN_TYPE, `${field}.coin`, "a canonical coin type"),
    quote: text(row.quote, COIN_TYPE, `${field}.quote`, "a canonical coin type"),
    lifecycle: row.lifecycle as WalletLaunchReward["lifecycle"],
    name: string("name"),
    symbol: string("symbol"),
    iconUrl: string("icon_url"),
    memeDecimals: decimals(row.meme_decimals, `${field}.meme_decimals`),
    quoteDecimals: nullableDecimals(row.quote_decimals, `${field}.quote_decimals`),
    entitledBy: row.entitled_by,
    curve,
    vault,
    outstanding,
  };
}

/** A validated `GET /v1/wallets/{address}/launch-rewards` page. */
export function parseWalletLaunchRewardsPage(address: string, body: unknown): WalletLaunchRewardsPage {
  const answer = object(body, "body", ["address", "launches", "next_cursor"], ["provenance"]);
  if (answer.address !== address) throw new ContractViolation("address", "must be the requested wallet");
  if (!Array.isArray(answer.launches) || answer.launches.length > PAGE_CEILING) {
    throw new ContractViolation("launches", `must be a list of at most ${PAGE_CEILING}`);
  }
  const launches = answer.launches.map((row, index) => parseWalletLaunchReward(row, `launches[${index}]`));
  if (new Set(launches.map((row) => row.launchId)).size !== launches.length) throw new ContractViolation("launches", "lists each launch once");
  return { address, launches, nextCursor: pageCursor(answer.next_cursor, walletLaunchRewardsCursor(address)) };
}

export function readWalletLaunchRewards(
  address: string,
  request: LaunchPageRequest,
  dependencies: MarketDataDependencies,
): Promise<RoutedRead<V1Answer<WalletLaunchRewardsPage>>> {
  return readV1("market", walletLaunchRewardsPath(address, request), (body) => parseWalletLaunchRewardsPage(address, body), dependencies);
}

/** One holder-reward payout the wallet received from a graduated launch's vault. */
export type HolderPayout = Readonly<{
  launchId: string;
  coin: string;
  quote: string;
  memeDecimals: null;
  quoteDecimals: null;
  vaultId: string;
  roundId: string;
  round: bigint;
  memeAmount: bigint;
  quoteAmount: bigint;
  paidAtMs: number;
  digest: string;
  relayedBy: string | null;
  position: string;
}>;

export type WalletHolderRewardsPage = Readonly<{ address: string; payouts: readonly HolderPayout[]; nextCursor: string | null }>;

function parsePayout(value: unknown, field: string) {
  const row = object(value, field, [
    "origin", "meme", "quote", "vault_id", "round_id", "round_number", "index", "amount",
    "timestamp_ms", "digest", "relayed_by", "cursor",
  ]);
  const origin = object(row.origin, `${field}.origin`, ["kind", "id"]);
  if (origin.kind !== "launch" && origin.kind !== "presale") throw new ContractViolation(`${field}.origin.kind`, "is unknown");
  const timestamp = row.timestamp_ms;
  if (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new ContractViolation(`${field}.timestamp_ms`, "must be a non-negative JSON safe integer");
  }
  const amount = pair(row.amount, `${field}.amount`);
  return {
    originKind: origin.kind,
    launchId: text(origin.id, SUI_OBJECT_ID_PATTERN, `${field}.origin.id`, "an object id"),
    coin: text(row.meme, COIN_TYPE, `${field}.meme`, "a canonical coin type"),
    quote: text(row.quote, COIN_TYPE, `${field}.quote`, "a canonical coin type"),
    memeDecimals: null,
    quoteDecimals: null,
    vaultId: text(row.vault_id, SUI_OBJECT_ID_PATTERN, `${field}.vault_id`, "an object id"),
    roundId: text(row.round_id, SUI_OBJECT_ID_PATTERN, `${field}.round_id`, "an object id"),
    round: parseAtomic(row.round_number, `${field}.round_number`, 64),
    memeAmount: amount.meme,
    quoteAmount: amount.quote,
    paidAtMs: timestamp,
    digest: text(row.digest, DIGEST, `${field}.digest`, "a transaction digest"),
    relayedBy: row.relayed_by === null ? null : text(row.relayed_by, SUI_OBJECT_ID_PATTERN, `${field}.relayed_by`, "an address"),
    position: text(row.cursor, EVENT_CURSOR, `${field}.cursor`, "a position"),
  };
}

/** The position's first three parts as a page token's tie-break. */
const tie = (position: string) => position.split(":").slice(0, 3).map((part) => part.padStart(20, "0"));

/** Validate the full vault payout page and keep the launch payouts for this view. */
export function parseWalletHolderRewardsPage(address: string, body: unknown): WalletHolderRewardsPage {
  const shape = walletHolderRewardsCursor(address);
  const answer = object(body, "body", ["wallet", "payouts", "next_cursor"], ["provenance"]);
  if (answer.wallet !== address) throw new ContractViolation("wallet", "must be the requested wallet");
  if (!Array.isArray(answer.payouts) || answer.payouts.length > PAGE_CEILING) {
    throw new ContractViolation("payouts", `must be a list of at most ${PAGE_CEILING}`);
  }
  const payouts = answer.payouts.map((row, index) => parsePayout(row, `payouts[${index}]`));
  const places = payouts.map((payout) => ({ key: [], tie: tie(payout.position) }));
  places.slice(1).forEach((place, index) => {
    if (compareKeys(shape, places[index]!, place) <= 0) throw new ContractViolation(`payouts[${index + 1}]`, "is out of order");
  });
  const nextCursor = pageCursor(answer.next_cursor, shape);
  if (nextCursor !== null) {
    const last = places.at(-1);
    if (!last || compareKeys(shape, last, decodeCursor(nextCursor, shape)) !== 0) {
      throw new ContractViolation("next_cursor", "must be the page's last place");
    }
  }
  return { address, payouts: payouts.filter((payout) => payout.originKind === "launch"), nextCursor };
}

export function readWalletHolderRewards(
  address: string,
  request: LaunchPageRequest,
  dependencies: MarketDataDependencies,
): Promise<RoutedRead<V1Answer<WalletHolderRewardsPage>>> {
  return readV1("market", walletHolderRewardsPath(address, request), (body) => parseWalletHolderRewardsPage(address, body), dependencies);
}

// --- A recipient's pending creator claims -------------------------------------------------------------

/** A launch whose creator caps the recipient can still claim, from its discovery row: what a claim row shows. */
export type PendingCreatorClaim = Readonly<{
  launchId: string;
  coin: string;
  quote: string;
  lifecycle: (typeof LAUNCH_LIFECYCLES)[number];
  name: string | null;
  symbol: string | null;
  iconUrl: string | null;
  /** The `LaunchCreated` position, `checkpoint:tx:event:sub`: the list's order. */
  createdCursor: string;
}>;

export type CreatorClaimsPage = Readonly<{ recipient: CreatorClaimsRecipient; launches: readonly PendingCreatorClaim[]; nextCursor: string | null }>;

const METADATA_KEYS = ["name", "symbol", "description", "icon_url"] as const;

/**
 * A discovery row (`launch_row`) as a pending claim. The row is the discovery views' whole pool
 * summary; only the identity, lifecycle and creation position are read here, each checked, and
 * the economics are the coin page's to read and validate.
 */
function parsePendingClaim(value: unknown, field: string): PendingCreatorClaim {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ContractViolation(field, "must be an object");
  const row = value as Record<string, unknown>;
  if (row.venue !== "blast_curve") throw new ContractViolation(`${field}.venue`, "must be blast_curve for a launch");
  const launchId = text(row.pool_id, SUI_OBJECT_ID_PATTERN, `${field}.pool_id`, "an object id");
  if (row.pool_key !== `blast_curve:${launchId}`) throw new ContractViolation(`${field}.pool_key`, "must name the launch's curve");
  if (!LAUNCH_LIFECYCLES.includes(row.lifecycle as PendingCreatorClaim["lifecycle"])) {
    throw new ContractViolation(`${field}.lifecycle`, "is not a launch lifecycle");
  }
  if (!("metadata" in row)) throw new ContractViolation(`${field}.metadata`, "is required");
  const metadata = row.metadata === null ? null : object(row.metadata, `${field}.metadata`, METADATA_KEYS);
  const string = (key: (typeof METADATA_KEYS)[number]) => {
    if (metadata === null) return null;
    if (typeof metadata[key] !== "string") throw new ContractViolation(`${field}.metadata.${key}`, "must be a string");
    return metadata[key] as string;
  };
  return {
    launchId,
    coin: text(row.coin, COIN_TYPE, `${field}.coin`, "a canonical coin type"),
    quote: text(row.quote, COIN_TYPE, `${field}.quote`, "a canonical coin type"),
    lifecycle: row.lifecycle as PendingCreatorClaim["lifecycle"],
    name: string("name"),
    symbol: string("symbol"),
    iconUrl: string("icon_url"),
    createdCursor: text(row.created_cursor, EVENT_CURSOR, `${field}.created_cursor`, "a position"),
  };
}

/**
 * A validated `GET /v1/creator-claims` page: the recipient it was asked for, discovery rows newest
 * first by creation position, each launch once, and a next cursor that is the last row's place in
 * the recipient's own list.
 */
export function parseCreatorClaimsPage(recipient: CreatorClaimsRecipient, body: unknown): CreatorClaimsPage {
  const shape = creatorClaimsCursor(recipient);
  const answer = object(body, "body", ["recipient_kind", "recipient", "launches", "next_cursor"], ["provenance"]);
  if (answer.recipient_kind !== recipient.kind || answer.recipient !== namedRecipient(recipient)) {
    throw new ContractViolation("recipient", "must be the requested recipient");
  }
  if (!Array.isArray(answer.launches) || answer.launches.length > PAGE_CEILING) {
    throw new ContractViolation("launches", `must be a list of at most ${PAGE_CEILING}`);
  }
  const launches = answer.launches.map((row, index) => parsePendingClaim(row, `launches[${index}]`));
  if (new Set(launches.map((row) => row.launchId)).size !== launches.length) throw new ContractViolation("launches", "lists each launch once");
  const places = launches.map((launch) => ({ key: [], tie: tie(launch.createdCursor) }));
  places.slice(1).forEach((place, index) => {
    if (compareKeys(shape, places[index]!, place) <= 0) throw new ContractViolation(`launches[${index + 1}]`, "is out of creation order");
  });
  const nextCursor = pageCursor(answer.next_cursor, shape);
  if (nextCursor !== null) {
    const last = places.at(-1);
    if (!last || compareKeys(shape, last, decodeCursor(nextCursor, shape)) !== 0) {
      throw new ContractViolation("next_cursor", "must be the page's last place");
    }
  }
  return { recipient, launches, nextCursor };
}

/** Reads a page of the launches whose creator caps `recipient` can still claim from blast-infra, validated, with its provenance. */
export function readCreatorClaims(
  recipient: CreatorClaimsRecipient,
  request: LaunchPageRequest,
  dependencies: MarketDataDependencies,
): Promise<RoutedRead<V1Answer<CreatorClaimsPage>>> {
  return readV1("market", creatorClaimsPath(recipient, request), (body) => parseCreatorClaimsPage(recipient, body), dependencies);
}
