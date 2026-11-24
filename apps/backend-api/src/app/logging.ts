import { createStructuredLog } from "@blast/core/lib/logging.ts";

const info = createStructuredLog((line) => process.stdout.write(`${line}\n`));
const error = createStructuredLog((line) => process.stderr.write(`${line}\n`), [], "error");

export function logBackendListening(role: "api" | "hints"): void {
  info("backend.listening", { role });
}

export function logAfterResponseFailure(): void {
  error("backend.after_response_failed");
}
