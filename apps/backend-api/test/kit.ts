import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as pause } from "node:timers/promises";

/** A loopback TCP port that was free when probed. */
export async function freePort(): Promise<number> {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));

  return port;
}

/**
 * Resolve with `origin` once a spawned backend answers `/v1/health` with 200.
 * Polling returns as soon as it is up, so `deadlineMs` only bounds a real
 * failure; keep it below the test's own timeout. A child that exits fails at
 * once, and either failure carries the child's latest output.
 */
export async function waitForHealth(
  child: ChildProcess,
  origin: string,
  deadlineMs: number,
  path = "/v1/health",
): Promise<string> {
  let output = "";
  const keep = (data: Buffer) => {
    output = (output + data.toString()).slice(-8_000);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  const deadline = performance.now() + deadlineMs;
  try {
    while (performance.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `Synthetic backend exited (${child.exitCode ?? child.signalCode}) before readiness:\n${output}`,
        );
      }
      try {
        const response = await fetch(origin + path, { signal: AbortSignal.timeout(5_000) });
        await response.body?.cancel();
        if (response.status === 200) {
          return origin;
        }
      } catch {
        /* The listener is starting. */
      }
      await pause(25);
    }
    throw new Error(`Synthetic backend readiness timed out after ${deadlineMs} ms:\n${output}`);
  } finally {
    child.stdout?.off("data", keep);
    child.stderr?.off("data", keep);
  }
}
