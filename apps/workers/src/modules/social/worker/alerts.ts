import { redact } from "@blast/core/lib/logging.ts";
import { ALERT_KEY, postAlertWebhook, WORKER_ALERT_REPEAT_MS, type AlertDetails } from "#workers/modules/worker-runtime/alerts.ts";
import type { WorkerLog } from "#workers/modules/worker-runtime/log.ts";

/**
 * The social worker's alerts, on the presale workers' alert path: a JSON
 * webhook (`SOCIAL_ALERT_WEBHOOK_URL`, else `PRESALE_ALERT_WEBHOOK_URL`) with
 * the same body shape (`text`, `alert`, `role`, `details`, `since`, `at`),
 * and one `social.alert` log line per outcome. Without a webhook the log
 * line is the alert (`outcome: "logged"`), so a log-based monitor still sees
 * it.
 *
 * Keys follow the workers' grammar (`ALERT_KEY`). A key is sent once its
 * condition has held for its grace period, then at most once per
 * `WORKER_ALERT_REPEAT_MS` while it holds; `clear` resets it. State lives in the
 * process, not the database: `social_worker_stalled` must still be sent when
 * the database is the problem. A standby taking over may send a held alert
 * once more (at most one extra message per takeover).
 */

export type SocialAlertOutcome = "sent" | "logged" | "held" | "failed";

export type SocialAlerts = Readonly<{
  raise(key: string, details?: AlertDetails, options?: Readonly<{ graceMs?: number }>): Promise<SocialAlertOutcome>;
  clear(key: string): void;
  /** Keys whose condition currently holds (for tests and the pass metric). */
  active(): readonly string[];
}>;

export function createSocialAlerts({
  webhookUrl,
  log,
  timeoutMs = 5_000,
  secrets = [],
  now = Date.now,
  fetcher = fetch,
}: Readonly<{
  webhookUrl: string | null;
  log: WorkerLog;
  timeoutMs?: number;
  secrets?: readonly string[];
  now?: () => number;
  fetcher?: typeof fetch;
}>): SocialAlerts {
  const state = new Map<string, { since: number; sentAt: number | null }>();

  async function post(key: string, details: AlertDetails, since: number, at: number): Promise<boolean> {
    if (!webhookUrl) return true;
    const body = JSON.stringify({
      text: `[social-worker] ${key}`,
      alert: key,
      role: "social-worker",
      network: "mainnet",
      details,
      since: new Date(since).toISOString(),
      at: new Date(at).toISOString(),
    });
    return postAlertWebhook(fetcher, webhookUrl, redact(body, [...secrets, webhookUrl]), timeoutMs);
  }

  return Object.freeze({
    async raise(key: string, details: AlertDetails = {}, options: Readonly<{ graceMs?: number }> = {}) {
      if (!ALERT_KEY.test(key)) throw new TypeError("An alert key is <kind> or <kind>:<subject>.");
      const at = now();
      const entry = state.get(key) ?? { since: at, sentAt: null };
      state.set(key, entry);
      const due = at - entry.since >= (options.graceMs ?? 0) && (entry.sentAt === null || at - entry.sentAt >= WORKER_ALERT_REPEAT_MS);
      if (!due) return "held";
      if (await post(key, details, entry.since, at)) {
        entry.sentAt = at;
        const outcome = webhookUrl ? "sent" : "logged";
        log("social.alert", { key, outcome, ...details });
        return outcome;
      }
      log("social.alert", { key, outcome: "failed", error: "webhook" });
      return "failed";
    },
    clear(key: string) {
      if (state.delete(key)) log("social.alert", { key, outcome: "cleared" });
    },
    active: () => [...state.keys()].sort(),
  });
}
