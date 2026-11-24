// Worker signer keys. Each process signs with one `*_SIGNER_KEY` variable and
// refuses to start beside any other; a command that signs nothing refuses
// them all. Errors name variables, never values.

import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

type Environment = Readonly<Record<string, string | undefined>>;

/** Throws unless every non-empty `*_SIGNER_KEY` in `environment` is `allowed` (`null`: none may be set). */
export function refuseForeignSignerKeys(environment: Environment, allowed: string | null): void {
  const foreign = Object.keys(environment).filter(
    (name) => name.endsWith("_SIGNER_KEY") && name !== allowed && environment[name]?.trim(),
  );
  if (foreign.length === 0) {
    return;
  }
  const rule = allowed ? `this process signs with ${allowed} alone` : "this command holds no signer key";
  throw new Error(`${foreign.join(", ")} must not be set: ${rule}.`);
}

/** The Ed25519 key in `variable`, after refusing every other signer key in `environment`. */
export function loadSignerKey(environment: Environment, variable: string): Ed25519Keypair {
  refuseForeignSignerKeys(environment, variable);
  const raw = environment[variable]?.trim();
  if (!raw) {
    throw new Error(`${variable} is required.`);
  }
  try {
    const parsed = decodeSuiPrivateKey(raw);
    if (parsed.scheme !== "ED25519") {
      throw new Error("scheme");
    }
    return Ed25519Keypair.fromSecretKey(parsed.secretKey);
  } catch {
    throw new Error(`${variable} is not a Bech32-encoded Sui Ed25519 private key.`);
  }
}

/** The raw secret key's other spellings (hex, base64, flagged base64), so a log line carries none of them. */
export function workerKeyEncodings(raw: string): string[] {
  try {
    const { secretKey } = decodeSuiPrivateKey(raw);
    const bytes = Buffer.from(secretKey);
    return [bytes.toString("hex"), bytes.toString("base64"), Buffer.concat([Buffer.of(0), bytes]).toString("base64")];
  } catch {
    return [];
  }
}
