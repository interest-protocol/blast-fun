import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { BLAST_DEPLOYMENTS, deploymentFingerprint } from "@interest-protocol/blast-deployments-sdk";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

import { objectIdSchema, u64Schema } from "#workers/lib/validation.ts";
import {
  AutoLpRefusal,
  executeAutoLp,
  prepareAutoLp,
  reconcileAutoLp,
} from "#workers/modules/auto-lp/compound.ts";
import { readAutoLpAttempt, recordAutoLpAttempt } from "#workers/modules/auto-lp/journal.ts";
import { expectedDeployment } from "@blast/core/modules/launchpad-contract/provenance.ts";
import { mainnetClient } from "#workers/modules/worker-runtime/client.ts";
import { evaluateWorkerAccess } from "#workers/modules/worker-runtime/deployment.ts";
import { loadSignerKey } from "#workers/modules/worker-runtime/keys.ts";
import { boundedProvider } from "#workers/modules/worker-runtime/provider.ts";
import { assertAddressBalanceEnvelope, SignerRefusal } from "#workers/modules/worker-runtime/signer.ts";

const KEY_VARIABLE = "AUTO_LP_SIGNER_KEY";
const bounds = { providerTimeoutMs: 10_000, confirmTimeoutMs: 30_000 };
const provider = boundedProvider(bounds.providerTimeoutMs);
const usage = `npm run -w @blast/workers vault:auto-lp -- plan|execute \\
  --state-dir DIR --vault ID --pool ID --reference-sqrt-price-x64 INTEGER \\
  --reference-time-ms UNIX_MS --gas-budget-mist MIST
npm run -w @blast/workers vault:auto-lp -- status --state-dir DIR
See docs/deploy/workers.md for authority, pricing, and recovery.`;

function id(value: unknown, field: string): string {
  const parsed = objectIdSchema.safeParse(value);
  if (!parsed.success || BigInt(parsed.data) === 0n) {
    throw new AutoLpRefusal(`${field} must be a full nonzero Sui ID.`);
  }
  return parsed.data;
}

function signerFor(sender: string): Ed25519Keypair {
  let signer: Ed25519Keypair;
  try {
    signer = loadSignerKey(process.env, KEY_VARIABLE);
  } catch (error) {
    throw new AutoLpRefusal(error instanceof Error ? error.message : `${KEY_VARIABLE} is unreadable.`);
  }
  if (signer.toSuiAddress() !== sender)
    throw new AutoLpRefusal("Auto-LP key does not match the configured sender.");
  return signer;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item)));
}

async function operatorContext(stateDir: string) {
  const directory = resolve(stateDir);
  const state = await lstat(directory).catch(() => null);
  if (!state?.isDirectory() || (state.mode & 0o077) !== 0 || state.uid !== process.getuid?.()) {
    throw new AutoLpRefusal(
      "The state directory must exist and be private to the current user (mode 0700).",
    );
  }
  const sender = id(process.env.AUTO_LP_SIGNER_ADDRESS, "AUTO_LP_SIGNER_ADDRESS");
  const selection = expectedDeployment(process.env);
  const deployment = BLAST_DEPLOYMENTS.mainnet;
  if (!deployment || !selection || deploymentFingerprint(deployment) !== selection.deployment) {
    throw new AutoLpRefusal("Select the released mainnet deployment and its exact fingerprint.");
  }
  let node: URL;
  try {
    node = new URL(process.env.BLAST_WORKER_SUI_GRPC_URL ?? "");
  } catch {
    throw new AutoLpRefusal("Set BLAST_WORKER_SUI_GRPC_URL to a trusted HTTPS full node.");
  }
  if (node.protocol !== "https:") throw new AutoLpRefusal("Auto-LP requires a trusted HTTPS full node.");
  const client = mainnetClient(node.href);
  const journal = resolve(directory, `auto-lp-${deployment.network}-${sender}.json`);
  return { sender, selection, deployment, client, journal };
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean" },
      "state-dir": { type: "string" },
      vault: { type: "string" },
      pool: { type: "string" },
      "reference-sqrt-price-x64": { type: "string" },
      "reference-time-ms": { type: "string" },
      "gas-budget-mist": { type: "string" },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  const [mode] = positionals;
  const stateDir = values["state-dir"];
  if (
    positionals.length !== 1 ||
    !stateDir ||
    (mode !== "plan" && mode !== "execute" && mode !== "status")
  ) {
    throw new AutoLpRefusal(usage);
  }
  const { sender, selection, deployment, client, journal } = await operatorContext(stateDir);
  const previous = await readAutoLpAttempt(journal, sender);
  if (previous || mode === "status") {
    if (!previous) throw new AutoLpRefusal("No Auto-LP attempt is recorded for this signer.");
    const { chainIdentifier } = await provider((signal) => client.core.getChainIdentifier({ signal }));
    if (chainIdentifier !== deployment.chainIdentifier)
      throw new AutoLpRefusal("Full node is on the wrong chain.");
    const result = await reconcileAutoLp(client, previous, provider);
    print({ attempt: previous, ...result });
    if (result.outcome !== "compounded" || mode === "execute") process.exitCode = 1;
    return;
  }

  const sqrtPrice = values["reference-sqrt-price-x64"];
  const referenceTime = values["reference-time-ms"];
  const gasBudget = u64Schema.safeParse(values["gas-budget-mist"]);
  if (
    !sqrtPrice ||
    !/^[1-9][0-9]{0,38}$/.test(sqrtPrice) ||
    !referenceTime ||
    !/^[0-9]{13}$/.test(referenceTime) ||
    !gasBudget.success
  ) {
    throw new AutoLpRefusal(
      "Provide a reference sqrt price, its Unix timestamp in milliseconds, and a gas budget in MIST.",
    );
  }
  const request = {
    sender,
    capId: id(process.env.AUTO_LP_ADMIN_CAP_ID, "AUTO_LP_ADMIN_CAP_ID"),
    vaultId: id(values.vault, "--vault"),
    poolId: id(values.pool, "--pool"),
    referenceSqrtPrice: BigInt(sqrtPrice),
    referenceTimeMs: Number(referenceTime),
    gasBudgetMist: BigInt(gasBudget.data),
  };
  const access = await evaluateWorkerAccess(
    {
      selection,
      environment: "production",
      manifestFile: null,
      timings: bounds,
    },
    client,
  );
  if (access.status !== "enabled")
    throw new AutoLpRefusal(`Deployment refused (${access.reasons.join(", ")}).`);
  const prepared = await prepareAutoLp({ client, access, request, provider });
  print({
    outcome: "simulated",
    attempt: prepared.attempt,
    referenceSqrtPrice: request.referenceSqrtPrice,
    referenceTimeMs: request.referenceTimeMs,
    ...prepared.preview,
  });
  if (mode === "plan") return;

  const signer = signerFor(sender);
  const result = await executeAutoLp({
    client,
    prepared,
    bounds,
    provider,
    sign: (bytes) => {
      assertAddressBalanceEnvelope(bytes, {
        sender,
        gasBudgetMist: request.gasBudgetMist,
        chainIdentifier: deployment.chainIdentifier,
      });
      return signer.signTransaction(bytes);
    },
    record: async (attempt) => {
      await recordAutoLpAttempt(journal, attempt);
      print({ outcome: "recorded", attempt });
    },
  });
  print({ digest: prepared.attempt.digest, ...result });
  if (result.outcome !== "compounded") process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  const message =
    error instanceof AutoLpRefusal || error instanceof SignerRefusal
      ? error.message
      : "Auto-LP operation failed. Check the inputs, trusted node, and attempt journal.";
  console.error(message);
  process.exitCode = 1;
}
