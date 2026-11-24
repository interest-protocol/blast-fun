import { normalizeSuiAddress, isValidSuiAddress } from "@mysten/sui/utils";
import { errorLabel } from "@blast/core/lib/metrics.ts";
import { positiveMistSchema } from "#workers/lib/validation.ts";
import type { WorkerAlerts } from "../worker-runtime/alerts.ts";
import { WORKER_METRICS } from "../worker-runtime/log.ts";
import type { WorkerJob, ProtocolWorkerAccess } from "../worker-runtime/runtime.ts";
import { SignerRefusal, type KeeperSigner } from "./signer.ts";

type Environment = Readonly<Record<string, string | undefined>>;
export function gasPoolSettings(environment: Environment, production: boolean) {
  const raw = environment.GAS_POOL_SPONSOR_ADDRESS?.trim();
  if (!raw && !production) return null;
  if (!raw || !isValidSuiAddress(raw)) throw new Error("GAS_POOL_SPONSOR_ADDRESS must be a Sui address.");
  const threshold = positiveMistSchema.safeParse(environment.GAS_POOL_LOW_BALANCE_MIST?.trim() || "50000000000");
  if (!threshold.success) throw new Error("GAS_POOL_LOW_BALANCE_MIST must be positive MIST.");
  return { sponsor: normalizeSuiAddress(raw), threshold: threshold.data };
}
export function gasPoolJob(settings: ReturnType<typeof gasPoolSettings>, alerts: WorkerAlerts): WorkerJob<ProtocolWorkerAccess, KeeperSigner> {
  let nextCheck = 0;
  return {
    name: "gas-pool-balance", signsNothing: true,
    sign() { throw new SignerRefusal("gas pool alert never signs"); },
    async run(context) {
      if (!settings || Date.now() < nextCheck) return { blocked: null };
      nextCheck = Date.now() + 60_000;
      try {
        const { balance } = await context.provider((signal) => context.client.core.getBalance({ owner: settings.sponsor, signal }));
        if (BigInt(balance.addressBalance ?? "0") < settings.threshold) await alerts.raise("pool_low", { addressBalanceMist: String(balance.addressBalance ?? "0"), thresholdMist: String(settings.threshold), sponsor: settings.sponsor });
        else await alerts.clear("pool_low");
        return { blocked: null };
      } catch (error) {
        context.log(WORKER_METRICS.handledError, { job: "gas-pool-balance", error: errorLabel(error) });
        return { blocked: ["sponsor-balance-unavailable"] };
      }
    },
  };
}
