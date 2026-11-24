import { parentPort, workerData } from "node:worker_threads";
import sharp from "sharp";
import { renderPresaleSharePng } from "../presale/share/image.ts";
import { renderReferralSharePng } from "../social/referrals/share-image.ts";
import { checkedSharePng, type ShareRenderJob } from "./renderer.ts";

async function validPnlImage(bytes: Uint8Array): Promise<boolean> {
  try {
    const image = sharp(bytes, { limitInputPixels: 1200 * 675, failOn: "warning" });
    const metadata = await image.metadata();
    if (metadata.format !== "png" || metadata.width !== 1200 || metadata.height !== 675 || (metadata.pages ?? 1) !== 1) return false;
    await image.raw().toBuffer();
    return true;
  } catch {
    return false;
  }
}

const job = workerData as ShareRenderJob | { kind: "pnl-validate"; bytes: Uint8Array };
if (job.kind === "pnl-validate") {
  parentPort!.postMessage(await validPnlImage(job.bytes));
} else {
  if (job.kind !== "presale" && job.kind !== "referral") throw new Error("Share render unavailable");
  const rendered = job.kind === "presale"
    ? await renderPresaleSharePng(job.sale, job.artwork)
    : await renderReferralSharePng(job.inviter, job.avatar);
  // Copy the exact bounded byte extent; never transfer a pooled Buffer slab.
  const bytes = Uint8Array.from(checkedSharePng(rendered));
  parentPort!.postMessage(bytes, [bytes.buffer]);
}
