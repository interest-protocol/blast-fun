import { parentPort, workerData } from "node:worker_threads";
import { buildMemePackageBytecode } from "@interest-protocol/blast-sdk/launchpad/template";
import { fromHex, toBase64 } from "@mysten/sui/utils";
import type { MemeBytecodeInput } from "./meme-template.ts";

const input = workerData as MemeBytecodeInput;
const module = await buildMemePackageBytecode({
  decimals: input.decimals,
  symbol: input.symbol,
  name: input.name,
  description: input.description,
  iconUrl: input.iconUrl,
  burnable: input.burnable,
  sellBurnBps: BigInt(input.sellBurnBps),
  creatorRecipient: { kind: "account", accountCommitment: fromHex(input.accountCommitment) },
}, { originalPackageId: input.launchpadOriginalPackageId, core: { originalPackageId: input.coreOriginalPackageId } });
const encoded = toBase64(module);
// Bound before structured clone as well as in the parent; no large reply crosses threads.
if (encoded.length > 1024 * 1024) throw new Error("Meme bytecode exceeds the build envelope");
parentPort!.postMessage(encoded);
