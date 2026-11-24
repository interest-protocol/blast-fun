import { createHash } from "node:crypto";
import {
  renderShareImage,
  type ShareRenderJob,
} from "@blast/server/modules/share-images/renderer.ts";

// Test-only IPC entry. The exact production singleton runs inside each actual main Bun process.
let started = false;
process.on("message", async (message: unknown) => {
  if (started || !message || typeof message !== "object") {
    return;
  }
  const input = message as { kind?: string; jobs?: ShareRenderJob[] };
  if (input.kind !== "fixture-share-run" || !Array.isArray(input.jobs) || input.jobs.length !== 3) {
    return;
  }
  started = true;
  const jobs = input.jobs;
  const times: number[] = [];
  const hashes: { job: number; hash: string }[] = [];
  const begin = performance.now();
  process.send?.({ kind: "share-start" });
  const branches = await Promise.allSettled(
    Array.from({ length: 2 }, async () => {
      for (const [job, input] of jobs.entries()) {
        const before = performance.now();
        const bytes = await renderShareImage(input);
        times.push(performance.now() - before);
        hashes.push({ job, hash: createHash("sha256").update(bytes).digest("hex") });
      }
    }),
  );
  process.send?.({
    kind: "share-done",
    count: hashes.length,
    times,
    hashes,
    durationMs: performance.now() - begin,
    failed: branches.some((branch) => branch.status === "rejected"),
  });
});
