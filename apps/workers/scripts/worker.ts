// The one worker entry: `start.sh <name>` runs a row of `src/processes.ts`, and `--list` prints
// the names. SIGTERM or SIGINT finishes the current pass, then the process exits 0; a
// configuration error exits 1 with one `<prefix>.config_error` line with an error label.

import { runWorkerProcess } from "../src/lib/worker-process.ts";
import { isWorkerName, WORKER_NAMES, WORKER_PROCESSES } from "../src/processes.ts";

const name = process.argv[2];

if (name === "--list") {
  console.log(WORKER_NAMES.join("\n"));
} else if (!isWorkerName(name)) {
  const message = `usage: apps/workers/start.sh <${WORKER_NAMES.join("|")}>`;
  console.error(JSON.stringify({ metric: "worker.config_error", message }));
  process.exitCode = 2;
} else {
  const { metricPrefix, load } = WORKER_PROCESSES[name];
  const worker = await load();
  await runWorkerProcess(metricPrefix, worker.secrets(process.env), (signal) => worker.run(process.env, signal));
}
