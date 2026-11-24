import { pino } from "pino";

/** Callers supply short labels and counts, never requests, SDK payloads or raw errors. */
export type LogFields = Readonly<Record<string, string | number | boolean | null | undefined>>;
export type StructuredLog = (name: string, fields?: LogFields) => void;

const SUI_PRIVATE_KEY = /suiprivkey1[0-9a-z]+/gi;
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@"]+@/gi;
const RESERVED_FIELDS = new Set(["metric", "at", "level", "time", "pid", "hostname", "msg"]);

/** Removes configured secrets, Sui private keys and URL credentials from a string. */
export function redact(text: string, secrets: readonly string[]): string {
  let output = text;
  for (const secret of secrets) {
    if (secret.length >= 8) {
      output = output.split(secret).join("[redacted]");
    }
  }
  return output.replace(SUI_PRIVATE_KEY, "[redacted]").replace(URL_CREDENTIALS, "$1[redacted]@");
}

/** Pino owns JSON encoding; callers choose the destination and its write guarantees. */
export function createStructuredLog(
  write: (line: string) => void = (line) => console.info(line),
  secrets: readonly string[] = [],
  level: "info" | "error" = "info",
): StructuredLog {
  const values = secrets.filter((secret) => secret.length >= 8);
  const logger = pino(
    {
      base: null,
      timestamp: () => `,"at":"${new Date().toISOString()}"`,
      browser: { disabled: true },
      redact: {
        paths: [
          "authorization",
          "cookie",
          "token",
          "password",
          "secret",
          "privateKey",
          "signerKey",
          "signature",
          "databaseUrl",
          "providerUrl",
        ],
        censor: "[redacted]",
      },
    },
    { write: (line) => write(line.trimEnd()) },
  );

  return (name, fields = {}) => {
    // Metrics are also imported by browser read clients. Pino's browser entry
    // is disabled, and this guard keeps their consoles and sinks untouched.
    if (typeof window !== "undefined") {
      return;
    }
    const safe: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (RESERVED_FIELDS.has(key)) {
        continue;
      }
      if (typeof value === "string") {
        safe[key] = redact(value, values);
      } else if (value === null || typeof value === "number" || typeof value === "boolean") {
        safe[key] = value;
      }
    }
    logger[level]({ ...safe, metric: redact(name, values) });
  };
}
