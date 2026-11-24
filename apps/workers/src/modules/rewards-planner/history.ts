import { decodeDelayedEvent } from "@interest-protocol/blast-admin-sdk/events";
import { treasuryDelayedKeys } from "@interest-protocol/blast-core/treasury";
import type { BlastDeployment } from "@interest-protocol/blast-deployments-sdk";
import { decodeVaultEvent } from "@interest-protocol/blast-vault-sdk/events";
import { vaultDeployment } from "@interest-protocol/blast-deployments-sdk";
import type { TransactionContext } from "@blast/core/modules/database/transaction.ts";
import type { SuiClientTypes } from "@mysten/sui/client";
import { z } from "zod";
import { parseStructTag } from "@mysten/sui/utils";
import { objectIdSchema } from "#workers/lib/validation.ts";
import { MissingRewardHistory, requireRewardCut } from "#workers/modules/reward-plan/evidence.ts";
import { PAGE_SIZE, type Cut } from "#workers/modules/reward-plan/plan.ts";

type Cursor = { checkpoint: string; tx_slot: string; event_slot: string };
type Movement = Cursor & { meme: bigint; quote: bigint; remainder?: { meme: bigint; quote: bigint } };
function compare(a: Cursor, b: Cursor): number {
  for (const field of ["checkpoint", "tx_slot", "event_slot"] as const) {
    if (BigInt(a[field]) !== BigInt(b[field])) return BigInt(a[field]) < BigInt(b[field]) ? -1 : 1;
  }
  return 0;
}
const evidenceSchema = z.array(z.object({ eventType: z.string(), bcs: z.string() }));
async function receipt(tx: TransactionContext, digest: string, checkpoint: string) {
  const { rows } = await tx.read<{ events: unknown; sender: string; checkpoint: string }>(
    "SELECT events,sender,checkpoint::text FROM chain_read_v1.transaction_evidence WHERE digest=$1 AND checkpoint=$2 AND success", [digest, checkpoint]);
  if (rows.length !== 1) throw new MissingRewardHistory("native-receipt");
  return { ...rows[0], events: evidenceSchema.parse(rows[0].events) };
}
export function nativeEvent(row: { sender: string; checkpoint: string }, event: { eventType: string; bcs: string }, digest: string, eventIndex: number): SuiClientTypes.EventEntry {
  const encoded = event.bcs.replaceAll("\n", "");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw new MissingRewardHistory("native-encoding");
  const tag = parseStructTag(event.eventType);
  return { packageId: tag.address, module: tag.module, json: null, eventType: event.eventType, bcs: bytes, sender: row.sender, checkpoint: row.checkpoint, transactionDigest: digest, eventIndex };
}

type Collection = Cursor & { tx_digest: string; fee_split: { routes: { destination: { kind: string } }[] }; route_meme_amounts: string[]; route_quote_amounts: string[] };
type RoundRow = Record<string, unknown>;

async function vaultEventAt(tx: TransactionContext, deployment: BlastDeployment, digest: string, checkpoint: string, slot: number) {
  const native = await receipt(tx, digest, checkpoint), event = native.events[slot];
  if (!event) throw new MissingRewardHistory("vault-event");
  return decodeVaultEvent(nativeEvent(native, event, digest, slot), vaultDeployment(deployment));
}

async function collectedMovement(tx: TransactionContext, deployment: BlastDeployment, vaultId: string, c: Collection): Promise<Movement> {
  if (c.fee_split.routes.length !== c.route_meme_amounts.length || c.fee_split.routes.length !== c.route_quote_amounts.length)
    throw new MissingRewardHistory("collection-route-shape");
  const decoded = await vaultEventAt(tx, deployment, c.tx_digest, c.checkpoint, Number(c.event_slot));
  if (decoded.kind !== "FeesCollected" || decoded.payload.vault_id !== vaultId || decoded.payload.route_meme_amounts.map(String).join(",") !== c.route_meme_amounts.join(",") || decoded.payload.route_quote_amounts.map(String).join(",") !== c.route_quote_amounts.join(",")) throw new MissingRewardHistory("collection-identity");
  let meme = 0n, quote = 0n;
  c.fee_split.routes.forEach((route, i) => {
    if (route.destination.kind === "holder_rewards") { meme += BigInt(c.route_meme_amounts[i]!); quote += BigInt(c.route_quote_amounts[i]!); }
  });
  return { ...c, meme, quote };
}

async function publishedMovement(tx: TransactionContext, deployment: BlastDeployment, vaultId: string, r: RoundRow): Promise<Movement> {
  const checkpoint = String(r.published_checkpoint), digest = String(r.published_tx_digest), slot = Number(r.published_event_slot);
  const published = await vaultEventAt(tx, deployment, digest, checkpoint, slot);
  if (published.kind !== "RoundPublished" || published.payload.vault_id !== vaultId || published.payload.round_id !== r.round_id) throw new MissingRewardHistory("publication-identity");
  const p = published.payload;
  return { checkpoint, tx_slot: String(r.published_tx_slot), event_slot: String(slot), meme: -p.meme_amount, quote: -p.quote_amount - p.gas_reserve_amount,
    remainder: { meme: p.meme_unallocated, quote: p.quote_unallocated } };
}

async function returnedMovement(tx: TransactionContext, deployment: BlastDeployment, vaultId: string, r: RoundRow, cut: Cut, prefix: "gas_settled" | "closed"): Promise<Movement | null> {
  if (!r[prefix]) return null;
  const fields = ["checkpoint", "tx_slot", "event_slot", "tx_digest"].map((field) => r[`${prefix}_${field}`]);
  if (fields.some((v) => v === null || v === undefined)) throw new MissingRewardHistory(`${prefix}-cursor`);
  const [checkpoint, tx_slot, event_slot, digest] = fields.map(String) as [string, string, string, string];
  if (BigInt(checkpoint) > BigInt(cut.checkpoint)) return null;
  const returned = await vaultEventAt(tx, deployment, digest, checkpoint, Number(event_slot));
  const kind = prefix === "gas_settled" ? "GasReserveSettled" : "RoundClosed";
  if (returned.kind !== kind || !("vault_id" in returned.payload) || returned.payload.vault_id !== vaultId || returned.payload.round_id !== r.round_id) throw new MissingRewardHistory(`${prefix}-identity`);
  const cursor = { checkpoint, tx_slot, event_slot };
  if (returned.kind === "GasReserveSettled") return { ...cursor, meme: 0n, quote: returned.payload.reserve_returned };
  if (returned.kind === "RoundClosed") return { ...cursor, meme: returned.payload.meme_returned, quote: returned.payload.quote_returned + returned.payload.gas_reserve_returned };
  throw new MissingRewardHistory(`${prefix}-identity`);
}

type ReplayRow = Cursor & { kind: "collection" | "published" | "gas_settled" | "closed"; row: RoundRow };

async function requireReturnCursors(tx: TransactionContext, vaultId: string, cut: Cut) {
  const { rows } = await tx.read<{ prefix: string }>(`SELECT CASE WHEN r.gas_settled AND
    (to_jsonb(r)->>'gas_settled_checkpoint' IS NULL OR to_jsonb(r)->>'gas_settled_tx_slot' IS NULL OR to_jsonb(r)->>'gas_settled_event_slot' IS NULL OR to_jsonb(r)->>'gas_settled_tx_digest' IS NULL)
    THEN 'gas_settled' ELSE 'closed' END AS prefix FROM chain_read_v1.vault_rounds r
    WHERE vault_id=$1 AND published_checkpoint<=$2 AND ((gas_settled AND
      (to_jsonb(r)->>'gas_settled_checkpoint' IS NULL OR to_jsonb(r)->>'gas_settled_tx_slot' IS NULL OR to_jsonb(r)->>'gas_settled_event_slot' IS NULL OR to_jsonb(r)->>'gas_settled_tx_digest' IS NULL))
      OR (closed AND (to_jsonb(r)->>'closed_checkpoint' IS NULL OR to_jsonb(r)->>'closed_tx_slot' IS NULL OR to_jsonb(r)->>'closed_event_slot' IS NULL OR to_jsonb(r)->>'closed_tx_digest' IS NULL))) LIMIT 1`, [vaultId, cut.checkpoint]);
  if (rows[0]) throw new MissingRewardHistory(`${rows[0].prefix}-cursor`);
}

async function replayPage(tx: TransactionContext, vaultId: string, cut: Cut, after: Cursor) {
  // Native event positions merge collections, publications and both return kinds into one walk.
  // JSON numeric amounts/cursors are converted to decimal strings before crossing the PG boundary.
  const { rows } = await tx.read<ReplayRow>(`SELECT kind,checkpoint::text,tx_slot::text,event_slot::text,row FROM (
    SELECT 'collection'::text AS kind,c.checkpoint,c.tx_slot,c.event_slot,
      to_jsonb(c)||jsonb_build_object('checkpoint',c.checkpoint::text,'tx_slot',c.tx_slot::text,'event_slot',c.event_slot::text,
        'route_meme_amounts',c.route_meme_amounts::text[],'route_quote_amounts',c.route_quote_amounts::text[]) AS row
      FROM chain_read_v1.vault_fee_collections c WHERE vault_id=$1 AND checkpoint<=$2
    UNION ALL
    SELECT 'published',r.published_checkpoint,r.published_tx_slot,r.published_event_slot,
      to_jsonb(r)||jsonb_build_object('published_checkpoint',r.published_checkpoint::text,'published_tx_slot',r.published_tx_slot::text,'published_event_slot',r.published_event_slot::text)
      FROM chain_read_v1.vault_rounds r WHERE vault_id=$1 AND published_checkpoint<=$2
    UNION ALL
    SELECT 'gas_settled',(to_jsonb(r)->>'gas_settled_checkpoint')::bigint,(to_jsonb(r)->>'gas_settled_tx_slot')::bigint,(to_jsonb(r)->>'gas_settled_event_slot')::bigint,
      to_jsonb(r)||jsonb_build_object('gas_settled_checkpoint',to_jsonb(r)->>'gas_settled_checkpoint','gas_settled_tx_slot',to_jsonb(r)->>'gas_settled_tx_slot','gas_settled_event_slot',to_jsonb(r)->>'gas_settled_event_slot')
      FROM chain_read_v1.vault_rounds r WHERE vault_id=$1 AND gas_settled AND (to_jsonb(r)->>'gas_settled_checkpoint')::bigint<=$2
    UNION ALL
    SELECT 'closed',(to_jsonb(r)->>'closed_checkpoint')::bigint,(to_jsonb(r)->>'closed_tx_slot')::bigint,(to_jsonb(r)->>'closed_event_slot')::bigint,
      to_jsonb(r)||jsonb_build_object('closed_checkpoint',to_jsonb(r)->>'closed_checkpoint','closed_tx_slot',to_jsonb(r)->>'closed_tx_slot','closed_event_slot',to_jsonb(r)->>'closed_event_slot')
      FROM chain_read_v1.vault_rounds r WHERE vault_id=$1 AND closed AND (to_jsonb(r)->>'closed_checkpoint')::bigint<=$2
    ) movements WHERE (checkpoint,tx_slot,event_slot)>($3::bigint,$4::bigint,$5::bigint)
    ORDER BY checkpoint,tx_slot,event_slot LIMIT $6`, [vaultId, cut.checkpoint, after.checkpoint, after.tx_slot, after.event_slot, PAGE_SIZE]);
  return rows;
}

async function replayMovement(tx: TransactionContext, deployment: BlastDeployment, vaultId: string, cut: Cut, event: ReplayRow): Promise<Movement> {
  if (event.kind === "collection") return collectedMovement(tx, deployment, vaultId, event.row as Collection);
  if (event.kind === "published") return publishedMovement(tx, deployment, vaultId, event.row);
  const movement = await returnedMovement(tx, deployment, vaultId, event.row, cut, event.kind);
  if (!movement) throw new MissingRewardHistory("return-position");
  return movement;
}
function applyMovement(funds: { meme: bigint; quote: bigint }, movement: Movement) {
  funds.meme += movement.meme; funds.quote += movement.quote;
  if (funds.meme < 0n || funds.quote < 0n) throw new MissingRewardHistory("funds-conservation");
  if (movement.remainder && (movement.remainder.meme !== funds.meme || movement.remainder.quote !== funds.quote)) throw new MissingRewardHistory("funds-conservation");
}

export async function historicalFunds(tx: TransactionContext, deployment: BlastDeployment, fingerprint: string, vaultId: string, cut: Cut) {
  await requireRewardCut(tx, fingerprint, cut);
  await requireReturnCursors(tx, vaultId, cut);
  const funds = { meme: 0n, quote: 0n };
  let after: Cursor = { checkpoint: "-1", tx_slot: "-1", event_slot: "-1" }, collections = 0, rounds = 0;
  for (;;) {
    const events = await replayPage(tx, vaultId, cut, after);
    for (const event of events) {
      if (compare(after, event) >= 0) throw new MissingRewardHistory("duplicate-funds-position");
      applyMovement(funds, await replayMovement(tx, deployment, vaultId, cut, event));
      if (event.kind === "collection") collections++;
      if (event.kind === "published") rounds++;
      after = event;
    }
    if (events.length < PAGE_SIZE) break;
  }
  return { ...funds, evidence: { checkpoint: cut.checkpoint, digest: cut.digest, collections, rounds } };
}

type NativeReceipt = { digest: string; events: unknown; sender: string; checkpoint: string };
function createdTreasuryValue(deployment: BlastDeployment, native: NativeReceipt, event: { eventType: string; bcs: string }, index: number, treasury: string): string | null {
  if (!event.eventType.includes("::blast_treasury::DestinationKey") || !event.eventType.startsWith(`${deployment.packages.admin.originalPackageId}::delayed::`)) return null;
  const decoded = decodeDelayedEvent(nativeEvent(native, event, native.digest, index), { adminPackageId: deployment.packages.admin.originalPackageId, packageId: deployment.packages.core.originalPackageId, keys: treasuryDelayedKeys });
  if (decoded.payload.parent !== treasury) return null;
  if (decoded.kind === "DelayedApplied") throw new MissingRewardHistory("treasury-applied-history");
  return decoded.kind === "DelayedCreated" ? String(decoded.payload.value) : null;
}
function treasuryCreationDestinations(deployment: BlastDeployment, receipts: NativeReceipt[], treasury: string) {
  const destinations = new Set<string>();
  let created = 0;
  for (const native of receipts) for (const [index, event] of evidenceSchema.parse(native.events).entries()) {
    const destination = createdTreasuryValue(deployment, native, event, index, treasury);
    if (destination !== null) { created++; destinations.add(destination); }
  }
  return { destinations, created };
}

/** Initial treasury is provable from its creation receipt. Later applies require an immutable history surface. */
export async function historicalTreasury(tx: TransactionContext, deployment: BlastDeployment, cut: Cut) {
  const treasury = deployment.sharedObjects.core.treasury.objectId;
  const { rows } = await tx.read<{ learned_checkpoint: string; learned_tx_slot: string; applied_checkpoint: string; applied_tx_slot: string; applied_event_slot: string; value: unknown }>(
    `SELECT s.learned_checkpoint::text,s.learned_tx_slot::text,d.applied_checkpoint::text,d.applied_tx_slot::text,d.applied_event_slot::text,d.value
     FROM chain_read_v1.stack_objects s JOIN chain_read_v1.delayed_values d ON d.owner_id=s.object_id
     WHERE s.kind='treasury' AND s.object_id=$1 AND d.key_type='blast_core::blast_treasury::DestinationKey'`, [treasury]);
  const row = rows[0];
  if (!row || BigInt(row.applied_checkpoint) > BigInt(cut.checkpoint) || row.applied_checkpoint !== row.learned_checkpoint || row.applied_tx_slot !== row.learned_tx_slot)
    throw new MissingRewardHistory("treasury-applied-history");
  let after = "", created = 0;
  const destinations = new Set<string>();
  for (;;) {
    const { rows: receipts } = await tx.read<NativeReceipt>(
      "SELECT digest,events,sender,checkpoint::text FROM chain_read_v1.transaction_evidence WHERE checkpoint=$1 AND success AND digest>$2 ORDER BY digest LIMIT $3", [row.learned_checkpoint, after, PAGE_SIZE]);
    const page = treasuryCreationDestinations(deployment, receipts, treasury);
    created += page.created;
    for (const destination of page.destinations) destinations.add(destination);
    if (created > 1) throw new MissingRewardHistory("treasury-creation-evidence");
    if (receipts.length < PAGE_SIZE) break;
    after = receipts.at(-1)!.digest;
  }
  if (created !== 1) throw new MissingRewardHistory("treasury-creation-evidence");
  const destination = objectIdSchema.parse(row.value);
  if (!destinations.has(destination)) throw new MissingRewardHistory("treasury-creation-evidence");
  return { treasury: destination, destinations: [...destinations] };
}
