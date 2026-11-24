import { parentPort, workerData } from "node:worker_threads";
import {
  buildAllowlist,
  type AllowlistEntry,
} from "@interest-protocol/blast-sdk/presale";

if (!parentPort)
  throw new Error("The allowlist builder requires its owned worker.");
parentPort.postMessage(buildAllowlist(workerData as readonly AllowlistEntry[]));
parentPort.close();
