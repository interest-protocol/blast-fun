import { z } from "zod";

// The workers' alert channel: a webhook (`BLAST_WORKER_ALERT_WEBHOOK_URL`)
// all three roles post to. An alert key names one condition
// (`job_stalled:<job>`, `relayer_low:<role>`, or a key a later job adds). While
// the condition holds, its key is sent once it has held for the key's grace
// period, then at most once an hour; when it clears, the next occurrence
// starts afresh. The state lives in `blast_worker_alerts`, so a restart or a
// standby taking over does not repeat an alert early. Alerts are telemetry:
// a database or webhook failure is logged and never fails a pass or a job,
// and an unsent alert is tried again on the next pass.

import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { Pool } from "pg";

import { errorLabel } from "@blast/core/lib/metrics.ts";
import { workerDatabase } from "#workers/lib/database.ts";
import { workerAlerts as alert } from "#workers/lib/database/schema.ts";
import { redact } from "@blast/core/lib/logging.ts";
import type { SocialAlertDetails } from "#workers/modules/social/worker/steps.ts";
import type { WorkerLog } from "./log.ts";

const MODULE = "worker-runtime";

/** A key repeats at most once per this while its condition holds (the social worker's alerts too). */
export const WORKER_ALERT_REPEAT_MS = 60 * 60 * 1_000;

/** A job failed or blocked for longer than this raises `job_stalled:<job>`. */
export const JOB_STALLED_AFTER_MS = 5 * 60 * 1_000;

/** `<kind>` or `<kind>:<subject>`: a lowercase kind, then a job, role, or chain identifier. Every worker's alert key. */
export const ALERT_KEY = /^[a-z][a-z0-9_]{0,63}(:[A-Za-z0-9._-]{1,128})?$/;

export const WORKER_ALERT_METRICS = Object.freeze({
  /** One alert key: `outcome` `sent`, `failed` (kept for the next pass) or `cleared`. */
  alert: "worker.alert",
});

/** What a raised key carries; the social worker's steps report the same shape (`SocialAlertDetails`). */
export type AlertDetails = SocialAlertDetails;

type Severity = "Info" | "Warning" | "Critical";
type Guidance = readonly [title: string, impact: string, action: string, severity: Severity];

function suiAmount(value: AlertDetails[string]): string | null {
  const parsed = z
    .string()
    .regex(/^\d{1,20}$/)
    .safeParse(value);
  if (!parsed.success) return null;
  const mist = BigInt(parsed.data);
  const fraction = String(mist % 1_000_000_000n)
    .padStart(9, "0")
    .replace(/0+$/, "");
  return `${mist / 1_000_000_000n}${fraction ? `.${fraction}` : ""} SUI`;
}

function fundingGuidance(kind: string, details: AlertDetails): Guidance | null {
  if (kind === "pool_low") {
    const empty = suiAmount(details.addressBalanceMist) === "0 SUI";
    return [
      empty ? "Sponsor has no spendable SUI" : "Sponsor funding is low",
      `Sponsor address balance: ${suiAmount(details.addressBalanceMist) ?? "unavailable"}. Alert threshold: ${suiAmount(details.thresholdMist) ?? "unavailable"}. ${empty ? "Sponsored transactions cannot be funded." : "Top up before sponsorship runs out of gas."}`,
      `Fund sponsor ${details.sponsor ?? "in the technical details"} above ${suiAmount(details.thresholdMist) ?? "the configured funding threshold"} using 0x2::coin::send_funds<0x2::sui::SUI>. Ordinary SUI coin objects at this address are not used by the sponsor.`,
      empty ? "Critical" : "Warning",
    ];
  }
  if (kind === "relayer_low") {
    return [
      "Worker wallet needs gas",
      `Worker address balance: ${suiAmount(details.balanceMist) ?? "unavailable"}. Low funding can prevent this worker from submitting transactions.`,
      `Fund worker ${details.address ?? "in the technical details"} above ${suiAmount(details.floorMist ?? details.thresholdMist) ?? "the configured funding threshold"} using 0x2::coin::send_funds<0x2::sui::SUI>, then confirm its jobs resume. SUI coin objects at this address do not pay its gas.`,
      suiAmount(details.balanceMist) === "0 SUI" ? "Critical" : "Warning",
    ];
  }
  return null;
}

function guidance(key: string, details: AlertDetails, role: string): Guidance {
  const kind = key.split(":")[0];
  const investigate = `Check Render logs for ${role}, alert ${key}, and reason ${details.reasons ?? details.reason ?? "in the technical details"}. Fix the reported cause and confirm the job resumes.`;
  const funding = fundingGuidance(kind, details);
  if (funding) return funding;
  if (kind === "job_stalled") {
    if (details.state === "blocked" && details.reasons === "release-gate-open")
      return [
        "Blast automation awaits activation",
        `Job ${details.job ?? key.split(":")[1]} is waiting for verified mainnet release checks. Other jobs reporting release-gate-open share the same release gate; automation remains paused.`,
        "Complete the release checklist: fund sponsor and worker wallets, grant the rewards key RewardsAdmin, finish the gas-pool rehearsal, and record verified release checks. Restarting will not clear this gate; keep it closed until the checks pass.",
        "Warning",
      ];
    return [
      "Worker job is stalled",
      `Job ${details.job ?? key.split(":")[1]} has ${details.state === "failed" ? "failed" : "been blocked"} for at least five minutes. Its work is delayed.`,
      investigate,
      details.state === "failed" ? "Critical" : "Warning",
    ];
  }
  switch (kind) {
    // The launchpad buyback operator (LP-22), which posts through this sender.
    case "buyback_min_out":
      return [
        "Buyback keeps failing its minimum output",
        `Vault ${details.vaultId ?? key.split(":")[1]} refused its buyback ${details.consecutive ?? "repeatedly"} times in a row: the pool returned less Meme than the reference price allows. Someone may be moving the pool around the buyback, or the reference is off.`,
        "Compare the pool's recent swaps with its 30-minute candles in blast-infra. If the pool is being manipulated, pause the operator (revoke a buyback release-gate check, docs/launchpad/runbooks/buyback-key.md); never raise the slippage to force it through.",
        "Warning",
      ];
    case "reward_published":
      return [
        "Reward round published",
        "The reward round is confirmed on chain. This is a completion notice.",
        "No action required. Keep the round ID for reconciliation.",
        "Info",
      ];
    case "sponsor_target_refusals":
      return [
        "Sponsor is refusing transactions",
        "Sponsor refusals exceeded the hourly threshold; some sponsored requests are being rejected.",
        "Check topReason in the details and the gas-pool logs. Verify target access and deployment identity; fix the rejected request or allowlist entry.",
        "Warning",
      ];
    case "presale_lag":
    case "sale_unreadable":
      return [
        "Presale data is unavailable or delayed",
        "Blast keeper cannot reliably discover or read current presales.",
        "Check blast-infra freshness and Sui provider health. If a sale is undecodable, compare its type and package with the deployment manifest before retrying.",
        "Warning",
      ];
    case "partner_unpaid":
      return [
        "Partner fees remain unpaid",
        "Partner fee collection has not completed for this presale.",
        "Check the presale's fee-collection attempt and transaction on chain. Resolve gas, permissions or contract refusal before retrying collection.",
        "Warning",
      ];
    case "migrate_blocked":
    case "lifecycle_overdue":
    case "deadline_near":
      return [
        "Presale settlement or migration needs attention",
        "The presale is blocked, overdue, or approaching its lifecycle deadline.",
        "Check the reason and deadline in the details, worker gas and venue fee limits. Use the manual-settle-migrate runbook if automatic processing cannot finish in time.",
        kind === "deadline_near" ? "Critical" : "Warning",
      ];
    case "opening_round_unsettled":
      return [
        "Opening round is not settled",
        `Launch ${details.launchId ?? key.split(":")[1]} ended its opening round and is still unsettled: nobody can trade it, and its bidders wait for their coins.`,
        "Check blast-keeper's opening_round.record logs and its gas. Settle the round from the coin page (anyone may), or fix the cause and confirm the keeper settles and delivers it.",
        "Critical",
      ];
    case "fee_claim_overdue":
      return [
        "Fee claim keeps failing",
        `Blast's and the partner's fees on launch ${details.launchId ?? key.split(":")[1]} are worth claiming, but the claim has failed for longer than the claim interval.`,
        "Check blast-keeper's fee_claim.record logs, its gas and the reason in the details. Fix the cause and confirm the next claim executes; anyone may send the same permissionless claim.",
        "Warning",
      ];
    default:
      return [
        "Worker condition needs investigation",
        `The worker reported ${key}. Review its technical details to assess the impact.`,
        investigate,
        "Warning",
      ];
  }
}

/** POSTs a JSON alert body within `timeoutMs`: true when the channel accepted it. Never throws. */
export async function postAlertWebhook(fetcher: typeof fetch, url: string, body: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

/** `sent`: the channel carried it now; `held`: within its grace or hour; `failed`: tried again next pass. */
export type AlertOutcome = "sent" | "held" | "failed";

export type WorkerAlerts = Readonly<{
  /**
   * The condition `key` names holds now. It is sent once it has held for
   * `graceMs` (default 0), then at most once per `WORKER_ALERT_REPEAT_MS`
   * while it keeps holding. A database or webhook failure is logged and
   * returned as `failed`; it throws only on a malformed key (a programming
   * error).
   */
  raise(
    key: string,
    details?: AlertDetails,
    options?: Readonly<{ graceMs?: number }>,
  ): Promise<AlertOutcome>;
  /** The condition no longer holds; its next occurrence alerts afresh. Never throws. */
  clear(key: string): Promise<void>;
}>;

/** The part of the alert channel the keeper jobs use: raise and clear. */
export type KeeperAlerts = Pick<WorkerAlerts, "raise" | "clear">;

export function createWorkerAlerts({
  pool,
  role,
  network,
  webhookUrl,
  timeoutMs,
  log,
  secrets = [],
  now = Date.now,
  fetcher = fetch,
}: Readonly<{
  pool: Pool;
  role: string;
  /** The network the process serves this pass, or `unselected`. */
  network: () => string;
  webhookUrl: string;
  /** Budget of one webhook call. */
  timeoutMs: number;
  log: WorkerLog;
  /** Values the posted body must never carry. */
  secrets?: readonly string[];
  now?: () => number;
  fetcher?: typeof fetch;
}>): WorkerAlerts {
  const db = workerDatabase(pool, MODULE);

  async function post(key: string, details: AlertDetails, since: Date, at: Date): Promise<boolean> {
    const clip = (text: string, limit: number): string => {
      const safe = redact(text, secrets);
      const suffix = "... [truncated]";
      return safe.length > limit ? safe.slice(0, limit - suffix.length) + suffix : safe;
    };
    const [title, impact, action, defaultSeverity] = guidance(key, details, role);
    const severity = details.severity === "critical" ? "Critical" : defaultSeverity;
    const activation =
      key.startsWith("job_stalled:") &&
      details.state === "blocked" &&
      details.reasons === "release-gate-open";
    const technical = clip(
      JSON.stringify(
        {
          alert: key,
          role,
          network: network(),
          details,
          since: since.toISOString(),
          at: at.toISOString(),
        },
        null,
        2,
      ),
      1_012,
    );
    const body = JSON.stringify({
      embeds: [
        {
          title: clip(title, 256),
          description: clip(impact, 512),
          color: severity === "Critical" ? 0xe74c3c : severity === "Warning" ? 0xf1c40f : 0x2ecc71,
          timestamp: at.toISOString(),
          fields: [
            { name: "Severity", value: severity, inline: true },
            {
              name: "Requires attention",
              value:
                severity === "Info"
                  ? "No action required"
                  : severity === "Critical"
                    ? "Act now"
                    : activation
                      ? "Before activation"
                      : "Action required",
              inline: true,
            },
            { name: "What to do", value: clip(action, 1_024) },
            { name: "Worker", value: clip(role, 128), inline: true },
            { name: "Network", value: clip(network(), 32), inline: true },
            { name: "Condition since", value: since.toISOString(), inline: true },
            { name: "Alert code", value: clip(key, 193) },
            {
              name: "Operator guides",
              value:
                "[Launch checklist](https://github.com/interest-protocol/blast-fun/blob/main/docs/deploy/LAUNCH-DEPLOY.md) · [Worker operations](https://github.com/interest-protocol/blast-fun/blob/main/docs/deploy/workers.md)",
            },
            { name: "Technical details", value: `\`\`\`json\n${technical}\n\`\`\`` },
          ],
        },
      ],
      allowed_mentions: { parse: [] },
    });
    return postAlertWebhook(fetcher, webhookUrl, body, timeoutMs);
  }

  async function raise(
    key: string,
    details: AlertDetails = {},
    options: Readonly<{ graceMs?: number }> = {},
  ): Promise<AlertOutcome> {
    if (!z.string().regex(ALERT_KEY).safeParse(key).success)
      throw new TypeError("An alert key is <kind> or <kind>:<subject>.");
    const at = new Date(now());
    const graceMs = options.graceMs ?? 0;
    try {
      // One statement notes the condition (its first sighting keeps its time)
      // and claims this hour's send when it is due, so two processes never
      // both send.
      const rows = await db
        .insert(alert)
        .values({
          alertKey: key,
          conditionSince: at,
          lastSentAt: graceMs === 0 ? at : null,
          updatedAt: at,
        })
        .onConflictDoUpdate({
          target: alert.alertKey,
          set: { updatedAt: at, lastSentAt: at },
          setWhere: and(
            lte(alert.conditionSince, new Date(at.getTime() - graceMs)),
            or(
              isNull(alert.lastSentAt),
              lte(alert.lastSentAt, new Date(at.getTime() - WORKER_ALERT_REPEAT_MS)),
            ),
          ),
        })
        .returning({
          conditionSince: alert.conditionSince,
          claimed: sql<boolean>`${alert.lastSentAt} IS NOT DISTINCT FROM ${at.toISOString()}::timestamptz`,
        });
      const row = rows[0];
      if (!row?.claimed) return "held";
      if (await post(key, details, row.conditionSince, at)) {
        log(WORKER_ALERT_METRICS.alert, { key, outcome: "sent" });
        return "sent";
      }
      // Unsent: give the claim back (any earlier send was over an hour ago), so the next pass tries again.
      await db
        .update(alert)
        .set({ lastSentAt: null })
        .where(and(eq(alert.alertKey, key), eq(alert.lastSentAt, at)));
      log(WORKER_ALERT_METRICS.alert, { key, outcome: "failed", error: "webhook" });
      return "failed";
    } catch (error) {
      log(WORKER_ALERT_METRICS.alert, { key, outcome: "failed", error: errorLabel(error) });
      return "failed";
    }
  }

  async function clear(key: string): Promise<void> {
    try {
      const rows = await db
        .delete(alert)
        .where(eq(alert.alertKey, key))
        .returning({ key: alert.alertKey });
      if (rows.length) log(WORKER_ALERT_METRICS.alert, { key, outcome: "cleared" });
    } catch (error) {
      log(WORKER_ALERT_METRICS.alert, { key, outcome: "failed", error: errorLabel(error) });
    }
  }

  return Object.freeze({ raise, clear });
}
