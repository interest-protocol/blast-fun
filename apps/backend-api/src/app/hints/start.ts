import { configuredRedis } from "@blast/core/lib/redis.ts";
import { logBackendListening } from "../logging.ts";
import { hintsConfig } from "./config.ts";
import { createHintsServer } from "./server.ts";

export function startHints() {
  const config = hintsConfig();
  const runtime = createHintsServer(
    // Live sockets close spread over half of the 10 s exit deadline below.
    { ...config, streamDrainMs: 5_000 },
    configuredRedis("quota")!,
    configuredRedis("private-replay")!,
  );
  logBackendListening("hints");
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      const deadline = setTimeout(() => process.exit(1), 10_000).unref();
      void runtime.drain().then(
        () => {
          clearTimeout(deadline);
          process.exit(0);
        },
        () => process.exit(1),
      );
    });
  }
}
