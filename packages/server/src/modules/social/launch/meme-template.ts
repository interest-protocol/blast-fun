import { Worker } from "node:worker_threads";

import { requestWorkSignal } from "@blast/server/lib/request-work.ts";

/**
 * A launch coin's package: the launchpad's `launch_ticket_template`
 * (`meme.move`) with the draft's name, ticker, line, logo, decimals, supply
 * kind and sell burn patched in, and the creator recipient set to the
 * account's commitment. The SDK patches the bytecode offline; it runs in a
 * worker thread so a slow WASM build never stalls the request loop.
 */
export type MemeBytecodeInput = Readonly<{
  decimals: number;
  symbol: string;
  name: string;
  description: string;
  iconUrl: string;
  burnable: boolean;
  sellBurnBps: string;
  /** The account's 32-byte creator commitment, hex. */
  accountCommitment: string;
  launchpadOriginalPackageId: string;
  coreOriginalPackageId: string;
}>;

export type MemeTemplate = Readonly<{ bytecode: (input: MemeBytecodeInput) => Promise<string> }>;

const MAX_BYTES = 1024 * 1024;

/** Two offline builds at a time, no queue; a permit survives cancellation until its worker exits. */
export function createMemeTemplateExecutor(ports: Readonly<{ timeoutMs?: number; worker?: (input: MemeBytecodeInput) => Worker }> = {}): MemeTemplate {
  let active = 0;
  return {
    async bytecode(input) {
      const signal = requestWorkSignal();
      signal?.throwIfAborted();
      if (active === 2) throw new Error("Meme bytecode busy");
      active++;
      let worker: Worker | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cancel: (() => void) | undefined;
      try {
        timer = setTimeout(() => cancel?.(), ports.timeoutMs ?? 4000);
        worker = ports.worker ? ports.worker(input) : new Worker(new URL("./meme-template-worker.ts", import.meta.url), {
          env: {}, workerData: input, stdout: true, stderr: true,
        });
        worker.stdout.resume();
        worker.stderr.resume();
        const result: unknown = await new Promise((resolve, reject) => {
          cancel = () => reject(new Error("Meme bytecode cancelled"));
          signal?.addEventListener("abort", cancel, { once: true });
          worker!.once("message", resolve);
          worker!.once("error", reject);
          worker!.once("exit", () => reject(new Error("Meme bytecode worker exited")));
          if (signal?.aborted) cancel();
        });
        if (typeof result !== "string" || result.length === 0 || result.length > MAX_BYTES) throw new Error("Meme bytecode unavailable");
        return result;
      } finally {
        clearTimeout(timer);
        if (cancel) signal?.removeEventListener("abort", cancel);
        try { if (worker) await worker.terminate(); }
        finally { active--; }
      }
    },
  };
}

export const launchMemeTemplate: MemeTemplate = createMemeTemplateExecutor();
