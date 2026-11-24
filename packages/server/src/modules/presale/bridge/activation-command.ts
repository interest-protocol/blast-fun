import type { AuthorizedOperator } from "@blast/server/modules/mission-control/operator/auth.ts";
import { OperatorError } from "@blast/server/modules/mission-control/operator/errors.ts";
import { z } from "zod";
import {
  BridgeChecklistError,
  bridgeActivationWarnings,
  buildBridgeActivationRecord,
  buildBridgeDeactivationRecord,
  evaluateBridgeActivation,
  parseBridgeActivationChecklist,
} from "./activation.ts";
import {
  parseBridgeTransferRegistration,
  type BridgeActivationRecord,
  type BridgeActivationRecords,
  type BridgeConfiguration,
  type BridgeTransferRegistration,
  type BridgeTransfers,
} from "@blast/core/modules/presale/bridge/contracts.ts";
import { evaluateBridgeWithdraw } from "./withdraw-activation.ts";

/**
 * The bridge activation operator command (`npm run presale:bridge-activation`).
 * See `docs/presale/runbooks/bridge-activation.md`.
 *
 * - `record <checklist.json>`: records the checklist against the deployment
 *   identity's Sui CCTP ids. A complete checklist activates the bridge for
 *   its forwarding mode; an incomplete one is recorded too and keeps it off.
 * - `deactivate <reason>`: records a deactivation; the bridge is off until
 *   the next complete checklist.
 * - `status`: the bridge's state now, and the latest record.
 * - `history [limit]`: the newest records (default 20), newest first.
 * - `register-test <source> <tx_hash> <sui_address> <amount> <presale_id>`:
 *   registers one checklist test burn while the bridge is off, with the
 *   public registration's validation and table, so the relayer worker
 *   (T-021, which processes registered transfers whatever the gate state)
 *   mints it. Idempotent on `(source, tx_hash)` like the public route.
 *
 * Records are never changed or deleted.
 */
export type BridgeActivationCommand =
  | Readonly<{ mode: "record"; checklistPath: string }>
  | Readonly<{ mode: "deactivate"; reason: string }>
  | Readonly<{ mode: "status" }>
  | Readonly<{ mode: "history"; limit: number }>
  | Readonly<{ mode: "register-test"; registration: BridgeTransferRegistration }>;

export type BridgeActivationCommandPorts = Readonly<{
  /** Reads and parses the checklist file as JSON. */
  readChecklist(path: string): Promise<unknown>;
  records: BridgeActivationRecords;
  /** The public registration's table. */
  transfers: Pick<BridgeTransfers, "register">;
  /** The deployment's bridge configuration (environment and identity). */
  configuration(): BridgeConfiguration;
}>;

function invalid(): OperatorError {
  return new OperatorError("OPERATOR_INPUT_INVALID");
}

function parseTestRegistration(args: readonly string[]): BridgeTransferRegistration {
  const parsed = z
    .tuple([z.literal("register-test"), z.string(), z.string(), z.string(), z.string(), z.string()])
    .safeParse(args);
  if (!parsed.success) throw invalid();
  const [, source, txHash, suiAddress, amount, presaleId] = parsed.data;
  try {
    const body = {
      source,
      tx_hash: txHash,
      sui_address: suiAddress,
      amount,
      presale_id: presaleId,
    };
    return parseBridgeTransferRegistration(body, null);
  } catch {
    throw invalid();
  }
}

export function parseBridgeActivationCommand(args: readonly string[]): BridgeActivationCommand {
  if (args[0] === "register-test") {
    return { mode: "register-test", registration: parseTestRegistration(args) };
  }
  const parsed = z
    .union([
      z
        .tuple([z.literal("record"), z.string().min(1)])
        .transform(([mode, checklistPath]) => ({ mode, checklistPath })),
      z
        .tuple([z.literal("deactivate"), z.string().min(1).max(500)])
        .transform(([mode, reason]) => ({ mode, reason })),
      z.tuple([z.literal("status")]).transform(([mode]) => ({ mode })),
      z.tuple([z.literal("history")]).transform(([mode]) => ({ mode, limit: 20 })),
      z
        .tuple([z.literal("history"), z.string().regex(/^[1-9][0-9]{0,2}$/)])
        .transform(([mode, limit]) => ({ mode, limit: Number(limit) })),
    ])
    .safeParse(args);
  if (!parsed.success) throw invalid();
  return parsed.data;
}

function summary(record: BridgeActivationRecord) {
  return {
    id: record.id,
    recorded_at: record.recordedAt.toISOString(),
    recorded_by: record.recordedBy,
    kind: record.kind,
    forwarding: record.forwarding,
    complete: record.complete,
    problems: [...record.problems],
  };
}

/** Which destinations withdrawals out of Sui may use under the latest record (no ids printed). */
function withdrawals(latest: BridgeActivationRecord | null, configuration: BridgeConfiguration) {
  const state = evaluateBridgeWithdraw(latest, configuration);
  return state.active
    ? { active: true, live: [...state.live] }
    : { active: false, reason: state.reason, live: [] };
}

export async function runBridgeActivationCommand(
  command: BridgeActivationCommand,
  operator: AuthorizedOperator,
  ports: BridgeActivationCommandPorts,
): Promise<Record<string, unknown>> {
  const configuration = ports.configuration();
  const recordedBy = `operator:${operator.operatorId}`;
  if (command.mode === "status") {
    const latest = await ports.records.latest();
    return {
      activation: evaluateBridgeActivation(latest, configuration),
      withdraw: withdrawals(latest, configuration),
      latest: latest ? summary(latest) : null,
    };
  }
  if (command.mode === "history")
    return { records: (await ports.records.history(command.limit)).map(summary) };
  if (command.mode === "register-test") {
    const transfer = await ports.transfers.register(command.registration);
    return {
      transfer,
      activation: evaluateBridgeActivation(await ports.records.latest(), configuration),
    };
  }

  let record: BridgeActivationRecord;
  let warnings: readonly string[] = [];
  try {
    if (command.mode === "deactivate") {
      record = await ports.records.record(
        buildBridgeDeactivationRecord({ reason: command.reason, recordedBy }),
      );
    } else {
      const checklist = parseBridgeActivationChecklist(
        await ports.readChecklist(command.checklistPath),
      );
      const identity = configuration.identity;
      const suiCctp = identity.status === "ready" ? (identity.identity.cctp ?? null) : null;
      warnings = bridgeActivationWarnings(checklist);
      record = await ports.records.record(
        buildBridgeActivationRecord({ checklist, suiCctp, recordedBy }),
      );
    }
  } catch (error) {
    if (error instanceof BridgeChecklistError) throw invalid();
    throw error;
  }
  // Report what the gate reads after the write, not the row just written (B-001).
  const latest = await ports.records.latest();
  const activation = evaluateBridgeActivation(latest, configuration);
  return {
    record: summary(record),
    warnings: [...warnings],
    activation,
    withdraw: withdrawals(latest, configuration),
  };
}
