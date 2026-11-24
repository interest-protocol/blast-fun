import { Worker } from "node:worker_threads";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import type { PresaleReceiptLogo } from "@blast/core/modules/mission-control/card-renderer/presale-receipt.ts";
import type { SocialPresaleSummary } from "@blast/core/modules/social/contracts/presales.ts";
import type { ReferralInviter } from "@blast/core/modules/social/referrals/share.ts";
import { requestWorkSignal } from "@blast/server/lib/request-work.ts";
import type { PresaleShareArtwork } from "../presale/share/image.ts";

export type ShareRenderJob =
  | Readonly<{ kind: "presale"; sale: SocialPresaleSummary; artwork: PresaleShareArtwork }>
  | Readonly<{ kind: "referral"; inviter: ReferralInviter; avatar: PresaleReceiptLogo | null }>;
type PnlValidationJob = Readonly<{ kind: "pnl-validate"; bytes: Uint8Array }>;
type ImageJob = ShareRenderJob | PnlValidationJob;
type RenderWorker = Pick<Worker, "terminate" | "stdout" | "stderr"> & {
  once(...args: Parameters<Worker["once"]>): unknown;
};
export const SHARE_RENDER_INPUT_BYTES = 12 * 1024 * 1024;
export const SHARE_RENDER_DTO_BYTES = 1024 * 1024;
export const SHARE_RENDER_OUTPUT_BYTES = 8 * 1024 * 1024;
export const PNL_VALIDATION_INPUT_BYTES = 4 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function checkInput(job: ImageJob): void {
  if (job.kind === "pnl-validate") {
    if (!(job.bytes instanceof Uint8Array) || job.bytes.byteLength > PNL_VALIDATION_INPUT_BYTES)
      throw new Error("PNL image exceeds its envelope");
    return;
  }
  if (job.kind !== "presale" && job.kind !== "referral") throw new Error("Share render unavailable");
  const metadata = job.kind === "presale"
    ? { kind: job.kind, sale: job.sale }
    : { kind: job.kind, inviter: job.inviter };
  if (Buffer.byteLength(JSON.stringify(metadata)) > SHARE_RENDER_DTO_BYTES
    || Buffer.byteLength(JSON.stringify(job)) > SHARE_RENDER_INPUT_BYTES) throw new Error("Share render input exceeds its envelope");
}

/** Validate before cloning out of the worker and again at the parent boundary. */
export function checkedSharePng(value: unknown): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength < PNG_SIGNATURE.byteLength
    || value.byteLength > SHARE_RENDER_OUTPUT_BYTES
    || !Buffer.from(value.buffer, value.byteOffset, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) throw new Error("Share render unavailable");
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

/** Both public share families use two workers, no queue, through actual worker termination. */
export function createShareImageExecutor(ports: Readonly<{
  timeoutMs?: number;
  worker?: (job: ImageJob) => RenderWorker;
}> = {}) {
  let active = 0;
  async function execute(job: ShareRenderJob): Promise<Buffer>;
  async function execute(job: PnlValidationJob): Promise<boolean>;
  async function execute(job: ImageJob): Promise<Buffer | boolean> {
    const started = performance.now();
    const timeoutMs = ports.timeoutMs ?? 30_000;
    const signal = requestWorkSignal();
    signal?.throwIfAborted();
    if (active >= 2) throw new Error("Share render busy");
    active++;
    let worker: RenderWorker | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    try {
      checkInput(job);
      signal?.throwIfAborted();
      if (performance.now() - started >= timeoutMs) throw new Error("Share render cancelled");
      timer = setTimeout(() => cancel?.(), Math.max(0, timeoutMs - (performance.now() - started)));
      const workerJob = job.kind === "pnl-validate"
        ? { kind: job.kind, bytes: Uint8Array.from(job.bytes) }
        : job;
      worker = ports.worker ? ports.worker(workerJob) : new Worker(new URL("./render-worker.ts", import.meta.url), {
        env: {}, workerData: workerJob, stdout: true, stderr: true,
      });
      worker.stdout.resume();
      worker.stderr.resume();
      const result = await new Promise<unknown>((resolve, reject) => {
        cancel = () => reject(new Error("Share render cancelled"));
        signal?.addEventListener("abort", cancel, { once: true });
        worker!.once("message", resolve);
        worker!.once("error", reject);
        worker!.once("exit", () => reject(new Error("Share render worker exited")));
        if (signal?.aborted || performance.now() - started >= timeoutMs) cancel();
      });
      if (job.kind !== "pnl-validate") return checkedSharePng(result);
      if (typeof result !== "boolean") throw new Error("PNL validation unavailable");
      return result;
    } finally {
      clearTimeout(timer);
      if (cancel) signal?.removeEventListener("abort", cancel);
      try { if (worker) await worker.terminate(); }
      finally { active--; }
    }
  }
  return execute;
}

export function renderShareImage(job: ShareRenderJob): Promise<Buffer> {
  return processSingleton("share-images.executor", () => createShareImageExecutor())(job);
}

/** Decode the original upload without changing the bytes later hashed and stored. */
export function validatePnlImage(bytes: Uint8Array): Promise<boolean> {
  return processSingleton("share-images.executor", () => createShareImageExecutor())({ kind: "pnl-validate", bytes });
}
