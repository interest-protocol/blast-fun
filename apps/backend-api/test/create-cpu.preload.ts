import { createHash } from "node:crypto";
import { BLAST_DEPLOYMENTS, presaleDeployment } from "@interest-protocol/blast-sdk/deployments";
import { presaleCoinTemplate } from "@blast/server/modules/social/create/coin-template.ts";

// Loaded only by the explicitly spawned native fixture; no production route or environment branch.
let started = false;
process.on("message", async (message: unknown) => {
  if (message !== "fixture-bytecode-run" || started) {
    return;
  }
  started = true;
  const deployment = presaleDeployment(BLAST_DEPLOYMENTS.mainnet!);
  const times: number[] = [];
  const hashes: string[] = [];
  const begin = performance.now();
  process.send?.({ kind: "bytecode-start", count: 0 });
  const branches = await Promise.allSettled(
    Array.from({ length: 2 }, async () => {
      for (let index = 0; index < 8; index++) {
        const before = performance.now();
        const result = await presaleCoinTemplate.bytecode(
          {
            name: "Meridian",
            symbol: "MRDN",
            description: "Representative local SDK fixture",
            iconUrl: "https://fixture.invalid/processed.webp",
            decimals: 9,
          },
          deployment,
        );
        times.push(performance.now() - before);
        hashes.push(createHash("sha256").update(JSON.stringify(result)).digest("hex"));
      }
    }),
  );
  process.send?.({
    kind: "bytecode-done",
    count: hashes.length,
    hashes,
    times,
    durationMs: performance.now() - begin,
    failed: branches.some((branch) => branch.status === "rejected"),
  });
});
