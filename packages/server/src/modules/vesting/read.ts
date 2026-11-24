import { primaryPool } from "@blast/core/modules/database/pool.ts";
import { ObjectError } from "@mysten/sui/client";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils";
import { VestingClient } from "@interest-protocol/blast-util-sdk/vesting";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { VestingReadError } from "@blast/core/modules/vesting/errors.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { socialMainnetClient } from "../social/route-kit/shared-runtime.ts";
import {
  VESTING_DEPLOYMENT,
  scheduleOf,
  type PublicVesting,
  type VestingActivity,
  type VestingDetail,
} from "@blast/core/modules/vesting/model.ts";

/** The mainnet node (`socialMainnetClient`), one per process, created on first use. */
export function vestingChain(): SuiGrpcClient {
  return socialMainnetClient("vesting.fullnode");
}
export function vestingClient(): VestingClient {
  return processSingleton("vesting.client", () => new VestingClient(vestingChain(), VESTING_DEPLOYMENT));
}
export function normalizeScheduleId(id: string): string {
  if (!isValidSuiAddress(id)) throw new VestingReadError("not_found");
  return normalizeSuiAddress(id);
}
const COLUMNS = `s.schedule_id,s.coin_type,s.beneficiary,s.creator,s.total::text,s.released::text,s.refunded::text,
 s.refund_recipient,s.cancel_cap_id,s.terms || jsonb_build_object('kind',s.kind) AS terms,s.status,
 s.created_timestamp_ms::text,s.created_digest,s.coin_name,s.coin_symbol,s.coin_decimals,s.coin_icon_url,true AS indexed`;
const COVERED = `EXISTS (SELECT FROM chain_read_v1.projection_coverage c WHERE c.pipeline = 'vesting' AND c.network = 'mainnet' AND c.fault_checkpoint IS NULL AND c.checkpoint >= s.applied_checkpoint)`;
type Dependencies = Readonly<{
  database: () => ReadableDatabase;
  client: Pick<VestingClient, "getVesting">;
  metadata: (
    coinType: string,
  ) => ReturnType<SuiGrpcClient["core"]["getCoinMetadata"]>;
  now: () => number;
}>;

/** Construction-only ports keep SQL and actual chain reads in the canonical backend. */
export function createVestingReads(dependencies: Dependencies) {
  async function readVesting(id: string): Promise<VestingDetail> {
    const normalized = normalizeScheduleId(id);
    let indexed: (PublicVesting & { applied_checkpoint: string }) | null = null;
    let coverage = false;
    try {
      const database = dependencies.database();
      indexed =
        (
          await database.read<PublicVesting & { applied_checkpoint: string }>(
            `SELECT s.applied_checkpoint::text, ${COLUMNS} FROM chain_read_v1.utility_vesting_schedules s WHERE s.schedule_id=$1 AND ${COVERED}`,
            [normalized],
          )
        ).rows[0] ?? null;
      coverage =
        (
          await database.read<{ ready: boolean }>(
            `SELECT EXISTS(SELECT FROM chain_read_v1.projection_coverage WHERE pipeline='vesting' AND network='mainnet' AND fault_checkpoint IS NULL) AS ready`,
          )
        ).rows[0]?.ready === true;
      if (indexed) {
        const events = await database.read<VestingActivity>(
          `SELECT checkpoint::text || ':' || tx_slot::text || ':' || event_slot::text AS event_id,kind,timestamp_ms::text,digest,payload FROM chain_read_v1.utility_vesting_events WHERE schedule_id=$1 AND checkpoint <= $2 ORDER BY checkpoint DESC,tx_slot DESC,event_slot DESC LIMIT 100`,
          [normalized, indexed.applied_checkpoint],
        );
        return {
          schedule: indexed,
          events: events.rows,
          now_ms: dependencies.now(),
        };
      }
    } catch {
      /* A live object still has an authoritative public link while backfill catches up. */
    }
    try {
      const state = await dependencies.client.getVesting(normalized);
      const metadata = await dependencies
        .metadata(state.coinType)
        .then((result) => result.coinMetadata)
        .catch(() => null);
      return {
        schedule: {
          schedule_id: normalized,
          coin_type: state.coinType,
          beneficiary: state.beneficiary,
          creator: null,
          total: String(state.totalAmount),
          released: String(state.released),
          refunded: "0",
          refund_recipient: state.refundRecipient,
          cancel_cap_id: null,
          terms: scheduleOf(state),
          status: "active",
          created_timestamp_ms: null,
          created_digest: null,
          coin_name: metadata?.name ?? null,
          coin_symbol: metadata?.symbol ?? null,
          coin_decimals: metadata?.decimals ?? null,
          coin_icon_url: metadata?.iconUrl ?? null,
          indexed: false,
        },
        events: [],
        now_ms: dependencies.now(),
      };
    } catch (error) {
      if (
        error instanceof ObjectError &&
        ["notFound", "deleted"].includes(error.reason)
      )
        throw new VestingReadError(
          error.reason === "notFound" && coverage ? "not_found" : "unavailable",
        );
      if (error instanceof TypeError) throw new VestingReadError("unsupported");
      throw new VestingReadError("unavailable");
    }
  }
  async function walletVestings(
    wallet: string,
  ): Promise<readonly PublicVesting[]> {
    const database = dependencies.database();
    const ready = (
      await database.read<{ ready: boolean }>(
        `SELECT EXISTS(SELECT FROM chain_read_v1.projection_coverage WHERE pipeline='vesting' AND network='mainnet' AND fault_checkpoint IS NULL AND checkpoint IS NOT NULL) AS ready`,
      )
    ).rows[0]?.ready;
    if (!ready) throw new VestingReadError("index_unavailable");
    return (
      await database.read<PublicVesting>(
        `SELECT ${COLUMNS} FROM chain_read_v1.utility_vesting_schedules s WHERE (s.beneficiary=$1 OR s.creator=$1) AND ${COVERED} ORDER BY s.created_checkpoint DESC,s.schedule_id LIMIT 200`,
        [wallet],
      )
    ).rows;
  }

  return Object.freeze({ readVesting, walletVestings });
}

const reads = createVestingReads({
  database: () => autocommitReader(primaryPool(), "social"),
  client: { getVesting: (id) => vestingClient().getVesting(id) },
  metadata: (coinType) => vestingChain().core.getCoinMetadata({ coinType }),
  now: Date.now,
});

export const readVesting = reads.readVesting;
export const walletVestings = reads.walletVestings;
