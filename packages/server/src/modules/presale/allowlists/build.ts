import { Worker } from "node:worker_threads";
import type {
  Allowlist,
  AllowlistEntry,
} from "@interest-protocol/blast-sdk/presale";
import { PresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";

let building = false;

/** One disposable CPU worker, no queue or inherited secrets; await actual thread cleanup. */
export async function buildAllowlistOffThread(
  entries: readonly AllowlistEntry[],
  signal: AbortSignal,
): Promise<Allowlist> {
  signal.throwIfAborted();
  if (building) throw new PresaleRouteError("service_unavailable");
  building = true;
  let worker: Worker | undefined;
  let abort: (() => void) | undefined;
  try {
    worker = new Worker(new URL("./build-worker.ts", import.meta.url), {
      workerData: entries,
      env: {},
      name: "presale-allowlist",
    });
    const owned = worker;
    return await new Promise<Allowlist>((resolve, reject) => {
      let received = false;
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      owned.once("message", (result: Allowlist) => {
        received = true;
        resolve(result);
      });
      owned.once("error", reject);
      owned.once("exit", (code) => {
        if (!received)
          reject(
            new Error(`Allowlist worker exited before its result (${code}).`),
          );
      });
      if (signal.aborted) abort();
    });
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
    if (worker) await worker.terminate();
    building = false;
  }
}
