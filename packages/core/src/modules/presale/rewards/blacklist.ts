import { z } from "zod";
import { presaleEventBcs, presaleEventModules } from "@interest-protocol/blast-sdk/presale";
import { normalizeStructTag, parseStructTag } from "@mysten/sui/utils";
import type {
  ReadableDatabase,
  ModuleTransaction,
} from "../../database/transaction.ts";

export const REWARD_BLACKLIST_LIMIT = 50;
const ZERO_ADDRESS = `0x${"0".repeat(64)}`;

export async function readRewardBlacklist(
  db: ReadableDatabase,
  network: string,
  coinType: string,
): Promise<string[]> {
  const { rows } = await db.read<{ wallets: string[] }>(
    "SELECT wallets FROM presale_reward_blacklists WHERE network=$1 AND coin_type=$2",
    [network, coinType],
  );
  return rows[0]?.wallets ?? [];
}

export async function saveRewardBlacklist(
  db: ModuleTransaction<"social">,
  network: string,
  coinType: string,
  wallets: readonly string[],
  updatedBy: string,
  expectedWallets?: readonly string[],
): Promise<boolean> {
  const result = await db.write(
    "presale_reward_blacklists",
    `INSERT INTO presale_reward_blacklists(network,coin_type,wallets,updated_by)
    SELECT $1,$2,$3::text[],$4
    WHERE $5::text[] IS NULL OR cardinality($5::text[])=0 OR EXISTS (
      SELECT 1 FROM presale_reward_blacklists WHERE network=$1 AND coin_type=$2
    )
    ON CONFLICT(network,coin_type) DO UPDATE
    SET wallets=EXCLUDED.wallets,updated_by=EXCLUDED.updated_by,updated_at=now()
    WHERE $5::text[] IS NULL OR presale_reward_blacklists.wallets=$5::text[]
    RETURNING coin_type`,
    [network, coinType, wallets, updatedBy, expectedWallets ?? null],
  );
  return result.rowCount === 1;
}

/** Creation terms are immutable. Missing native evidence must never turn a team wallet into an eligible holder. */
export async function readRewardTeamWallets(
  db: ReadableDatabase,
  input: Readonly<{
    presaleId: string;
    coinType: string;
    originalPackageId: string;
    endCheckpoint: string;
  }>,
): Promise<string[]> {
  if (input.presaleId === ZERO_ADDRESS) return [];
  const eventPrefix = `${input.originalPackageId}::${presaleEventModules.PresaleCreated}::PresaleCreated<`;
  const { rows } = await db.read<{ events: unknown }>(
    `SELECT * FROM (WITH creation_checkpoint AS MATERIALIZED (
      SELECT h.checkpoint FROM chain_read_v1.checkpoint_headers h
      WHERE h.timestamp_ms=(
        SELECT p.created_at_ms FROM chain_read_v1.presales p WHERE p.presale_id=$1 AND p.sale_token=$2
      ) AND h.checkpoint<=$3::bigint
    )
    SELECT e.events FROM creation_checkpoint h
    JOIN chain_read_v1.transaction_evidence e ON e.checkpoint=h.checkpoint AND e.success
    WHERE EXISTS (
      SELECT 1 FROM jsonb_array_elements(e.events) event WHERE starts_with(event->>'eventType',$4)
    ) LIMIT 1001) creation_evidence`,
    [input.presaleId, input.coinType, input.endCheckpoint, eventPrefix],
  );
  if (rows.length > 1000) throw new Error("Presale creation evidence exceeds its bounded page.");
  const matches: string[][] = [];
  for (const row of rows) {
    const events = z.array(z.unknown()).safeParse(row.events);
    if (!events.success) throw new Error("Invalid presale creation evidence.");
    for (const candidate of events.data) {
      const wallets = allocationRecipients(candidate, eventPrefix, input.coinType, input.presaleId);
      if (wallets !== null) matches.push(wallets);
    }
  }
  if (matches.length !== 1) throw new Error("Presale creation evidence is missing or ambiguous.");
  return [...new Set(matches[0])].sort();
}

function allocationRecipients(
  candidate: unknown,
  eventPrefix: string,
  coinType: string,
  presaleId: string,
): string[] | null {
  const parsed = z.record(z.string(), z.unknown()).safeParse(candidate);
  if (!parsed.success) throw new Error("Invalid presale creation event.");
  const event = parsed.data;
  if (!z.string().startsWith(eventPrefix).safeParse(event.eventType).success) return null;
  const tag = parseStructTag(event.eventType as string);
  if (tag.typeParams.length !== 2 || normalizeStructTag(tag.typeParams[0]!) !== coinType)
    return null;
  const encodedBytes = z.string().safeParse(event.bcs);
  if (!encodedBytes.success) throw new Error("Invalid presale creation bytes.");
  // PostgreSQL encode(bytea,'base64') inserts a newline every 76 characters.
  const encoded = encodedBytes.data.replaceAll("\n", "");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw new Error("Invalid presale creation encoding.");
  const created = presaleEventBcs.PresaleCreated.parse(bytes);
  if (created.presale_id !== presaleId) return null;
  if (created.recipients.length !== created.recipient_bps.length)
    throw new Error("Invalid presale allocation recipients.");
  return created.recipients.filter((_, index) => created.recipient_bps[index]! > 0n)
    .map(({ destination }) => destination);
}
