import { decodeProtocolFeesPaid } from "@interest-protocol/blast-core/protocol-fees";
import { z } from "zod";
import { decodeLaunchpadEvent } from "@interest-protocol/blast-sdk/launchpad";
import { decodePresaleEvent } from "@interest-protocol/blast-sdk/presale";
import { parseStructTag, normalizeStructTag } from "@mysten/sui/utils";
import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import type { ModuleTransaction } from "@blast/core/modules/database/transaction.ts";
import { sharedVestingExecution } from "../claims/vesting.ts";
import {
  readStepCursor,
  writeStepCursor,
  type SocialWorkerBounds,
  type SocialWorkerStep,
} from "../worker/steps.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

export const REFERRAL_ACCOUNTING_STEP = "referral-accounting";
const packageId = z.string().regex(SUI_OBJECT_ID_PATTERN);
const profileSchema = z
  .object({
    network: z.literal("mainnet"),
    deployment_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    launchpad_original_package: packageId.nullable().default(null),
    presale_original_package: packageId,
    core_original_package: packageId,
    first_checkpoint: z
      .string()
      .regex(/^[0-9]{1,16}$/)
      .refine((value) => Number.isSafeInteger(Number(value))),
  })
  .refine((p) => new Set([p.launchpad_original_package, p.presale_original_package, p.core_original_package]).size === 3);
export type ReferralAccountingProfile = z.infer<typeof profileSchema>;
export const parseReferralAccountingProfile = (
  value: unknown,
): ReferralAccountingProfile => profileSchema.parse(value);

type Cursor = {
  profile: ReferralAccountingProfile;
  checkpoint: string;
  digest: string;
  complete_checkpoint: string;
  as_of_ms: number;
};
type Evidence = {
  digest: string;
  checkpoint: string;
  timestamp_ms: string;
  sender: string;
  success: boolean;
  events: unknown;
};
const PAGE = 64;
// The evidence view encodes the events of every Sui transaction it scans, Blast's or not,
// so one statement reads at most SCAN_WINDOW checkpoints (#839). A pass keeps scanning
// windows until it fills a page, reaches the bounds or spends SCAN_BUDGET_MS.
const SCAN_WINDOW = 100;
const SCAN_BUDGET_MS = 3_000;
// The SDK decoders throw on events they do not know, so only ledger events reach them.
const LAUNCHPAD_LEDGER_EVENTS = new Set(["LaunchTicketCreated", "LaunchCreated", "Bought", "Sold", "ProtocolFeesAccrued"]);
const PRESALE_LEDGER_EVENTS = new Set(["Committed", "PresaleFunded", "PresaleCancelled"]);
// Page transactions before expanding events; delayed presale fee payments are included even without lifecycle events.
export const REFERRAL_RECEIPTS_SQL = `SELECT digest,checkpoint::text,timestamp_ms::text,sender,success,events
 FROM chain_read_v1.transaction_evidence
 WHERE (checkpoint,digest) > ($1::bigint,$2::text) AND checkpoint <= $3::bigint
 AND EXISTS (SELECT 1 FROM jsonb_array_elements(events) e WHERE split_part(e->>'eventType','::',1)=ANY($4::text[]))
 ORDER BY transaction_evidence.checkpoint,digest LIMIT ${PAGE}`;
assertChainReadThroughViews(REFERRAL_RECEIPTS_SQL);

type Entry = {
  kind: string;
  entity: string;
  quoteType?: string;
  volume?: bigint;
  quote?: bigint;
  meme?: bigint;
  total?: bigint;
  accepted?: bigint;
};
async function append(
  tx: ModuleTransaction<"social">,
  row: Evidence,
  index: number,
  entry: Entry,
) {
  await tx.write(
    "social_referral_events",
    `INSERT INTO social_referral_events
    (digest,event_index,checkpoint,timestamp_ms,sender,kind,entity_id,quote_type,volume_atoms,quote_atoms,meme_atoms,total_atoms,accepted_atoms)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`,
    [
      row.digest,
      index,
      row.checkpoint,
      row.timestamp_ms,
      row.sender,
      entry.kind,
      entry.entity,
      entry.quoteType ?? null,
      String(entry.volume ?? 0n),
      String(entry.quote ?? 0n),
      String(entry.meme ?? 0n),
      String(entry.total ?? 0n),
      String(entry.accepted ?? 0n),
    ],
  );
}

async function importReceipt(
  tx: ModuleTransaction<"social">,
  row: Evidence,
  profile: ReferralAccountingProfile,
) {
  const execution = sharedVestingExecution(row);
  if (!execution)
    throw new Error("Referral receipt is incomplete; cursor retained.");
  if (!execution.success) return;
  for (const [index, event] of execution.events.entries()) {
    const tag = parseStructTag(event.eventType);
    const input = {
      ...event,
      sender: row.sender,
      packageId: tag.address,
      module: tag.module,
      json: null,
      checkpoint: row.checkpoint,
      transactionDigest: row.digest,
      eventIndex: index,
    };
    if (
      profile.launchpad_original_package &&
      tag.address === profile.launchpad_original_package &&
      tag.module === "events" &&
      LAUNCHPAD_LEDGER_EVENTS.has(tag.name)
    ) {
      await importLaunchpadEvent(
        tx,
        row,
        index,
        input,
        profile.launchpad_original_package,
      );
    } else if (
      tag.address === profile.presale_original_package &&
      tag.module === "events" &&
      PRESALE_LEDGER_EVENTS.has(tag.name)
    ) {
      await importPresaleEvent(tx, row, index, input, profile);
    } else if (tag.address === profile.core_original_package &&
      tag.module === "blast_core_events" && tag.name === "ProtocolFeesPaid") {
      const decoded = decodeProtocolFeesPaid(input, { originalPackageId: profile.core_original_package });
      const p = decoded.payload;
      const witness = normalizeStructTag(p.package_witness);
      if (witness === `${profile.presale_original_package}::blast_presale_package::PackageWitness`) {
        await append(tx, row, index, {
          kind: "presale_fee", entity: p.origin, quoteType: decoded.quoteType, quote: p.quote_amount,
        });
      } else if (witness === `${profile.launchpad_original_package}::blast_fun::PackageWitness`) {
        await append(tx, row, index, {
          kind: "curve_claim", entity: p.origin, quote: p.quote_amount, meme: p.meme_amount,
          total: p.quote_amount + p.partner_quote_amount, accepted: p.meme_amount + p.partner_meme_amount,
        });
      }
    }
  }
}

type EventInput = Parameters<typeof decodeLaunchpadEvent>[0];
async function importLaunchpadEvent(
  tx: ModuleTransaction<"social">,
  row: Evidence,
  index: number,
  input: EventInput,
  originalPackageId: string,
) {
  const decoded = decodeLaunchpadEvent(input, {
    originalPackageId,
  });
  if (decoded.kind === "LaunchTicketCreated" && decoded.memeType) {
    await tx.write(
      "social_referral_entities",
      `INSERT INTO social_referral_entities(entity_id,kind,meme_type)
      VALUES ($1,'ticket',$2) ON CONFLICT DO NOTHING`,
      [decoded.payload.ticket_id, decoded.memeType],
    );
  } else if (decoded.kind === "LaunchCreated" && decoded.quoteType) {
    const p = decoded.payload;
    await tx.write(
      "social_referral_entities",
      `INSERT INTO social_referral_entities(entity_id,kind,ticket_id,quote_type,partnered)
      VALUES ($1,'launch',$2,$3,$4) ON CONFLICT DO NOTHING`,
      [
        p.launch_id,
        p.ticket_id,
        decoded.quoteType,
        p.partner_id !== null,
      ],
    );
  } else if (decoded.kind === "Bought" || decoded.kind === "Sold") {
    const p = decoded.payload;
    const volume =
      decoded.kind === "Bought"
        ? decoded.payload.quote_in
        : decoded.payload.quote_out_gross -
          p.protocol_quote_fee -
          p.creator_quote_fee;
    if (volume < 0n) throw new Error("Negative executed referral volume.");
    await append(tx, row, index, {
      kind: "curve",
      entity: p.launch_id,
      volume,
      quote: p.protocol_quote_fee,
      meme: p.protocol_meme_fee,
    });
  } else if (decoded.kind === "ProtocolFeesAccrued") {
    const p = decoded.payload;
    await append(tx, row, index, {
      kind: "graduation",
      entity: p.launch_id,
      quote: p.quote_amount,
      meme: p.meme_amount,
    });
  }
}

async function importPresaleEvent(
  tx: ModuleTransaction<"social">,
  row: Evidence,
  index: number,
  input: EventInput,
  profile: ReferralAccountingProfile,
) {
  const decoded = decodePresaleEvent(input, {
    originalPackageId: profile.presale_original_package,
  });
  const p = decoded.payload;
  if (!("presale_id" in p) || decoded.quoteType === null) return;
  const common = {
    entity: p.presale_id,
    quoteType: normalizeStructTag(decoded.quoteType),
  };
  if (decoded.kind === "Committed") {
    await append(tx, row, index, {
      ...common,
      kind: "commit",
      volume: decoded.payload.quote,
    });
  } else if (decoded.kind === "PresaleFunded") {
    await append(tx, row, index, {
      ...common,
      kind: "funded",
      total: decoded.payload.total_commitments,
      accepted: decoded.payload.accepted_quote,
    });
  } else if (decoded.kind === "PresaleCancelled") {
    await append(tx, row, index, { ...common, kind: "cancelled" });
  }
}

/** Up to a page of receipts after the cursor, read one short checkpoint window per statement. */
async function scanReceipts(
  tx: ModuleTransaction<"social">,
  cursor: Pick<Cursor, "checkpoint" | "digest">,
  bound: number,
  packages: string[],
) {
  const deadline = performance.now() + SCAN_BUDGET_MS;
  const rows: Evidence[] = [];
  // Later windows start after the previous one: (through + 1, '') precedes every digest there.
  let after = [cursor.checkpoint, cursor.digest];
  let through = Number(cursor.checkpoint);
  do {
    through = Math.min(bound, through + SCAN_WINDOW);
    const page = await tx.read<Evidence>(REFERRAL_RECEIPTS_SQL, [...after, through, packages]);
    rows.push(...page.rows.slice(0, PAGE - rows.length));
    after = [String(through + 1), ""];
  } while (rows.length < PAGE && through < bound && performance.now() < deadline);
  return { rows, through };
}

export async function collectReferralRevenue(
  tx: ModuleTransaction<"social">,
  bounds: SocialWorkerBounds,
  profile: ReferralAccountingProfile,
) {
  const state = await readStepCursor<Cursor>(tx, REFERRAL_ACCOUNTING_STEP);
  if (
    state &&
    JSON.stringify(parseReferralAccountingProfile(state.profile)) !==
      JSON.stringify(profile)
  )
    throw new Error(
      "Referral accounting profile changed; explicit ledger rebuild required.",
    );
  const first = BigInt(profile.first_checkpoint);
  const cursor = state ?? {
    checkpoint: String(first - 1n),
    digest: "",
    complete_checkpoint: String(first - 1n),
    as_of_ms: 0,
  };
  await tx.read(
    "SELECT chain_read_v1.require_cut($1,$2,$3,$4,ARRAY['intake']::text[])",
    [
      profile.network,
      profile.deployment_fingerprint,
      bounds.checkpoint,
      bounds.checkpointDigest,
    ],
  );
  const coverage = await tx.read<{ first_checkpoint: string }>(
    `SELECT first_checkpoint::text FROM chain_read_v1.projection_coverage
    WHERE pipeline='intake' AND network=$1 AND deployment_fingerprint=$2`,
    [profile.network, profile.deployment_fingerprint],
  );
  if (!coverage.rows[0] || BigInt(coverage.rows[0].first_checkpoint) > first)
    throw new Error("Referral source does not cover deployment history.");
  if (BigInt(bounds.checkpoint) < BigInt(cursor.checkpoint))
    throw new Error("Referral source is behind the published cursor.");
  const { rows, through } = await scanReceipts(tx, cursor, bounds.checkpoint, [
    profile.core_original_package,
    profile.presale_original_package,
    ...(profile.launchpad_original_package
      ? [profile.launchpad_original_package]
      : []),
  ]);
  for (const row of rows) await importReceipt(tx, row, profile);
  const last = rows.at(-1);
  const finished = rows.length < PAGE;
  let timestampMs = bounds.timestampMs;
  if (finished && through < bounds.checkpoint) {
    const header = await tx.read<{ timestamp_ms: number }>(
      "SELECT timestamp_ms::float8 AS timestamp_ms FROM chain_read_v1.checkpoint_headers WHERE checkpoint=$1",
      [through],
    );
    if (!header.rows[0])
      throw new Error("Referral scan checkpoint header is unavailable.");
    timestampMs = header.rows[0].timestamp_ms;
  }
  await writeStepCursor(tx, REFERRAL_ACCOUNTING_STEP, {
    profile,
    checkpoint: finished ? String(through) : last!.checkpoint,
    digest: finished ? "~" : last!.digest,
    complete_checkpoint: finished
      ? String(through)
      : cursor.complete_checkpoint,
    as_of_ms: finished ? timestampMs : cursor.as_of_ms,
  });
}

export function referralRevenueStep(
  profile: ReferralAccountingProfile,
): SocialWorkerStep {
  return {
    name: REFERRAL_ACCOUNTING_STEP,
    pipeline: "presale",
    requiredPipelines: profile.launchpad_original_package
      ? ["market", "presale"]
      : ["presale"],
    run: async (tx, bounds) => {
      await collectReferralRevenue(tx, bounds!, profile);
      return {};
    },
  };
}
