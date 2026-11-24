import { open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { isValidStructTag, isValidTransactionDigest } from "@mysten/sui/utils";
import { z } from "zod";

import { objectIdSchema, u64Schema } from "#workers/lib/validation.ts";
import { AutoLpRefusal, type AutoLpAttempt } from "./compound.ts";

const attemptSchema = z.strictObject({
  digest: z.string().refine(isValidTransactionDigest),
  epoch: u64Schema,
  eventType: z.string().refine(isValidStructTag),
  vaultId: objectIdSchema,
  sender: objectIdSchema,
});

export async function readAutoLpAttempt(path: string, sender: string): Promise<AutoLpAttempt | null> {
  let data: string;
  try {
    data = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new AutoLpRefusal("The attempt journal could not be read.");
  }
  try {
    const attempt = attemptSchema.parse(JSON.parse(data));
    if (attempt.sender === sender) return attempt;
  } catch {
    // An incomplete record also fences the signer after an interrupted write.
  }
  throw new AutoLpRefusal("The attempt journal is invalid. Resolve it before another submission.");
}

/** Exclusive creation fences concurrent executions. Both the record and its directory must survive a crash before sending. */
export async function recordAutoLpAttempt(path: string, attempt: AutoLpAttempt): Promise<void> {
  const directory = await open(dirname(path), "r");
  try {
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(attempt)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await directory.sync();
  } catch {
    throw new AutoLpRefusal(
      "The attempt journal could not be recorded exclusively. No transaction was submitted.",
    );
  } finally {
    await directory.close();
  }
}
