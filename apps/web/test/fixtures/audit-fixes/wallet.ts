import type { VestingAttempt, VestingIntent } from "@blast/core/modules/vesting/model.ts";
import { VestingReviewRequiredError, VestingSubmissionPendingError } from "#web/components/vesting/execute-reviewed.ts";
export const address = `0x${"a".repeat(64)}`;
export const probe = { mode: "pending", account: "A", prepares: 0, executes: 0, refreshes: 0, digest: "fixture-original-digest" };
const attempt = (): VestingAttempt => ({ request_id: "fixture", action: "create", state: "submitted", digest: probe.digest, transaction_bytes: "not-signable", schedule_id: null, gas_budget: "1000000", expires_at_ms: Date.now() + 60000, sponsor_reservation_id: "fixture" });
export function useVestingWallet() {
  return { wallet: probe.account === "signed-out" ? null : address, viewer: { signedIn: probe.account !== "signed-out", sessionIdentity: probe.account }, walletLoading: false, walletError: false, busy: false, phase: "idle", fee: "sponsored" as const, node: null,
    prepare: async (intent: VestingIntent) => { probe.prepares++; return { ...attempt(), action: intent.action }; },
    execute: async (value: VestingAttempt) => { probe.executes++; if (probe.mode === "reject") throw new VestingReviewRequiredError("Wallet rejected. Nothing submitted."); if (probe.mode === "lost") throw new VestingSubmissionPendingError("Lost submission response. Check the original transaction."); return value; },
    refresh: async (value: VestingAttempt) => { probe.refreshes++; return value; }, retryWallet() {},
  };
}
Object.assign(window, { auditWallet: probe });
