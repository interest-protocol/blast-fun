import { Worker } from "node:worker_threads";
import { requestWorkSignal } from "@blast/server/lib/request-work.ts";
import { presaleCoinDependencies, type CoinTemplate } from "./chain.ts";

export type CoinBytecodeInput = Readonly<{
  coin: Parameters<CoinTemplate["bytecode"]>[0];
  deployment: Parameters<CoinTemplate["bytecode"]>[1];
}>;
type Bytecode = Awaited<ReturnType<CoinTemplate["bytecode"]>>;
export const COIN_BYTECODE_MAX_BYTES = 1024 * 1024;

function checkedBytecode(value: unknown, dependencies: readonly string[]): Bytecode {
  if (!value || typeof value !== "object") throw new Error("Coin bytecode unavailable");
  const result = value as Partial<Bytecode>;
  if (!Array.isArray(result.modules) || result.modules.length !== 1 || typeof result.modules[0] !== "string"
    || !Array.isArray(result.dependencies) || result.dependencies.length !== dependencies.length
    || !result.dependencies.every((value, index) => value === dependencies[index])
    || Buffer.byteLength(JSON.stringify(result)) > COIN_BYTECODE_MAX_BYTES) throw new Error("Coin bytecode unavailable");
  return result as Bytecode;
}

/** Two offline builds, no queue. A permit survives cancellation until the worker exits. */
export function createCoinTemplateExecutor(ports: Readonly<{
  timeoutMs?: number;
  worker?: (input: CoinBytecodeInput) => Worker;
}> = {}): CoinTemplate["bytecode"] {
  let active = 0;
  return async (coin, deployment) => {
    const signal = requestWorkSignal();
    signal?.throwIfAborted();
    if (active === 2) throw new Error("Coin bytecode busy");
    active++;
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    try {
      signal?.throwIfAborted();
      const input: CoinBytecodeInput = { coin, deployment };
      timer = setTimeout(() => cancel?.(), ports.timeoutMs ?? 4000);
      worker = ports.worker ? ports.worker(input) : new Worker(new URL("./coin-template-worker.ts", import.meta.url), {
        env: {}, workerData: input, stdout: true, stderr: true,
      });
      worker.stdout.resume();
      worker.stderr.resume();
      const result: unknown = await new Promise((resolve, reject) => {
        cancel = () => reject(new Error("Coin bytecode cancelled"));
        signal?.addEventListener("abort", cancel, { once: true });
        worker!.once("message", resolve);
        worker!.once("error", reject);
        worker!.once("exit", () => reject(new Error("Coin bytecode worker exited")));
        if (signal?.aborted) cancel();
      });
      return checkedBytecode(result, presaleCoinDependencies(deployment));
    } finally {
      clearTimeout(timer);
      if (cancel) signal?.removeEventListener("abort", cancel);
      try { if (worker) await worker.terminate(); }
      finally { active--; }
    }
  };
}

/** All publish branches share the same process admission; the SDK remains authoritative. */
export const presaleCoinTemplate: CoinTemplate = { bytecode: createCoinTemplateExecutor() };
