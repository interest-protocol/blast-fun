import { parentPort, workerData } from "node:worker_threads";
import { buildPresaleCoinPackageBytecode } from "@interest-protocol/blast-sdk/presale";
import { toBase64 } from "@mysten/sui/utils";
import type { CoinBytecodeInput } from "./coin-template.ts";
import { presaleCoinDependencies } from "./chain.ts";

const { coin, deployment } = workerData as CoinBytecodeInput;
const coinModule = await buildPresaleCoinPackageBytecode({
  ...coin,
  metadataCapRecipient: null,
}, deployment);
const result = { modules: [toBase64(coinModule)], dependencies: presaleCoinDependencies(deployment) };
// Bound before structured clone as well as in the parent; no large reply crosses threads.
if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) throw new Error("Coin bytecode exceeds the build envelope");
parentPort!.postMessage(result);
