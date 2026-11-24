/** Explicit offline file conversion only. No runtime application imports this entry point. */
import { openSync, readSync, closeSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { recipientRecoveryFile } from "./recovery-file.ts";

try {
  const [sourcePath, outputPath, ...extra] = process.argv.slice(2);
  if (!sourcePath || !outputPath || extra.length !== 0)
    throw new Error("recipient_recovery_usage");
  const input = openSync(sourcePath, "r");
  const limit = 1_048_576;
  const bounded = Buffer.alloc(limit + 1);
  let bytes = 0;
  try {
    let read: number;
    while (
      bytes < bounded.length &&
      (read = readSync(input, bounded, bytes, bounded.length - bytes, null)) > 0
    )
      bytes += read;
  } finally {
    closeSync(input);
  }
  if (bytes > limit) throw new Error("recipient_recovery_size");
  const source = bounded.subarray(0, bytes);
  const output = recipientRecoveryFile(source);
  const descriptor = openSync(outputPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, output, "utf8");
  } finally {
    closeSync(descriptor);
  }
  console.log(
    JSON.stringify({
      status: "prepared",
      source_sha256: createHash("sha256").update(source).digest("hex"),
      output_sha256: createHash("sha256").update(output).digest("hex"),
    }),
  );
} catch (error) {
  const detail = error instanceof Error && /^recipient_recovery_invalid: [a-z0-9_.]{1,100}$/.test(error.message)
    ? ` (${error.message})` : "";
  console.error(
    `Recipient recovery refused${detail}. Check the input, provide a new output path, and retain the original file.`,
  );
  process.exitCode = 1;
}
