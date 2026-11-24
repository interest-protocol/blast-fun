import { errorLabel } from "@blast/core/lib/metrics.ts";
import { createStructuredLog } from "@blast/core/lib/logging.ts";
import * as Effect from "effect/Effect";

const shutdownSignals = ["SIGINT", "SIGTERM"] as const;

/** Signals finish the current pass; fatal errors emit structured labels. */
export async function runWorkerProcess(
  metricPrefix: "worker" | "social.worker",
  secrets: readonly string[],
  run: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  let fatalExit: Promise<never> | undefined;
  const log = createStructuredLog((line) => {
    // Piped stderr can apply backpressure, so exit after the stream writes the line.
    fatalExit = new Promise(() => {
      process.stderr.write(`${line}\n`, () => process.exit(1));
    });
  }, secrets, "error");
  const abort = () => controller.abort();

  function fail(kind: "crashed" | "config_error", fields: Record<string, string>): void {
    if (fatalExit) {
      return;
    }
    process.exitCode = 1;
    log(`${metricPrefix}.${kind}`, fields);
  }

  const crash = (error: unknown) => fail("crashed", { error: errorLabel(error) });
  const installHandlers = Effect.sync(() => {
    for (const signal of shutdownSignals) process.on(signal, abort);
    process.on("uncaughtException", crash);
    process.on("unhandledRejection", crash);
  });

  // The job signal stops the loop between passes while the Effect waits for the current pass.
  const runJob = Effect.tryPromise({
    try: () => run(controller.signal),
    catch: errorLabel,
  }).pipe(Effect.catch((error) => Effect.sync(() => fail("config_error", { error }))));

  const releaseHandlers = Effect.promise(() => fatalExit ?? Promise.resolve()).pipe(
    Effect.andThen(Effect.sync(() => {
      for (const signal of shutdownSignals) process.off(signal, abort);
      process.off("uncaughtException", crash);
      process.off("unhandledRejection", crash);
    })),
  );

  await Effect.runPromise(Effect.acquireUseRelease(installHandlers, () => runJob, () => releaseHandlers));
}
