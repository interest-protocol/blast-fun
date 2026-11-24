import { recordMetric, type MetricFields } from "@blast/core/lib/metrics.ts";

export const REDACTED = "[redacted]";

/*
 * Secret names. A name is split into words (camelCase, snake_case, kebab-case,
 * SCREAMING_CASE), and each word is compared without a plural "s", so
 * `apiKeys`, `api_keys` and `X-API-Key` read alike. Presale's own vocabulary
 * stays public: `token` is usually the sale coin (`token_bps`, `tokens`) and
 * `auth` a mode, so those words mark a secret only in a credential position.
 */

/** Words that make any name a secret. */
const ALWAYS_SECRET: ReadonlySet<string> = new Set([
  "authorization",
  "secret",
  "password",
  "passphrase",
  "mnemonic",
  "credential",
  "apikey",
  "jwt",
  "pepper",
]);
/** Words that make a name a secret when they end it: `accessToken`, `userSignature`, `uploadCsv`, `sessionCookie`. */
const SECRET_LAST: ReadonlySet<string> = new Set(["token", "signature", "csv", "cookie"]);
/** `key` is a secret after one of these (`apiKey`, `privKey`, `secret_key`); `keyId` and `publicKey` are not. */
const KEY_QUALIFIERS: ReadonlySet<string> = new Set(["api", "private", "priv", "secret", "signing", "access", "session"]);
/** `auth` is a secret before one of these (`authHeader`), or when it ends a longer name (`gasPoolAuth`). */
const AUTH_CREDENTIALS: ReadonlySet<string> = new Set(["header", "token", "key", "secret", "value", "credential"]);

function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function singular(word: string): string {
  return word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

/**
 * Whether a field or setting name holds a secret: Authorization, gasPoolAuth,
 * GAS_POOL_AUTH_TOKEN, x-api-key, apiKeys, privKey, user_signature,
 * RATE_LIMIT_SUBJECT_PEPPER, a CSV `file`… but not token_bps, tokens, auth,
 * authMode, privateSale, signatureScheme, keyId or publicKey.
 */
export function isSecretName(name: string): boolean {
  const written = nameWords(name);
  const words = written.map(singular);
  if (words.length === 1 && (words[0] === "key" || words[0] === "file" || written[0] === "token")) return true;
  return words.some((word, index) => {
    const last = index === words.length - 1;
    if (ALWAYS_SECRET.has(word)) return true;
    if (SECRET_LAST.has(word)) return last && (words.length > 1 || word !== "token");
    if (word === "key") return index > 0 && KEY_QUALIFIERS.has(words[index - 1]);
    if (word === "auth") return last ? words.length > 1 : AUTH_CREDENTIALS.has(words[index + 1]);
    return false;
  });
}

/** Secret shapes in free text, in the order they are replaced. */
const SECRET_PATTERNS: readonly RegExp[] = [
  // Credentials in an Authorization value: Privy tokens, gas-pool tokens, app secrets.
  /\b(?:Bearer|Basic)\s+(?!(?:Bearer|Basic)\b)[^\s,;"'\\]+/gi,
  // Agent API keys (T-013), sent in X-Blast-Api-Key: `blast_ak_` and 43 base64url characters, wherever they appear.
  /\bblast_ak_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g,
  // JWTs (Privy access and identity tokens).
  /\beyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]+/g,
  // Bech32 Sui private keys.
  /\bsuiprivkey1[02-9ac-hj-np-z]{20,}/gi,
  // Long base64 runs: user signatures (a Sui signature is 97+ bytes) and raw key or transaction bytes.
  /[A-Za-z0-9+/]{86,}={0,2}/g,
];

/**
 * Sui keystore keys: base64 of a flag byte (0, 1 or 2) and 32 key bytes, 44
 * characters from "A". A 44-character base58 transaction or checkpoint digest
 * can look the same; one labelled as a digest (`digest: A…`, `"tx_digest":"A…"`)
 * stays, any other is redacted.
 */
const KEYSTORE_KEY = /(?<![A-Za-z0-9+/])A[A-Za-z0-9+/]{43}(?![A-Za-z0-9+/=])/g;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const DIGEST_LABEL = /\b[a-z_]*digest["'\\]*[ \t]*[:= \t][ \t]*["'\\]*$/i;

function redactKeystoreKeys(text: string): string {
  return text.replace(KEYSTORE_KEY, (value: string, offset: number) =>
    BASE58.test(value) && DIGEST_LABEL.test(text.slice(Math.max(0, offset - 48), offset)) ? value : REDACTED,
  );
}

/**
 * A secret name and its separator; the value follows. Forms: `name=value`,
 * `name: value`, `"name":"value"`, escaped JSON `\"name\":\"value\"`, and
 * CLI flags `--name value` or `--name=value`.
 */
const NAMED_VALUE = /(\\?["']|)([A-Za-z][A-Za-z0-9_.-]{0,63})\1[ \t]*[:=][ \t]*|--([A-Za-z][A-Za-z0-9_-]{0,63})(?:[ \t]+|=)/g;
const BARE_VALUE = /[^\s"'`,;&)}\]\\]+/y;

/** Replaces the value after every secret name. A value already redacted is left as it is. */
function redactNamedValues(text: string): string {
  let output = "";
  let last = 0;
  for (const match of text.matchAll(NAMED_VALUE)) {
    if (!isSecretName(match[2] ?? match[3])) continue;
    const start = match.index + match[0].length;
    if (start < last || text.startsWith(REDACTED, start)) continue;
    const end = namedValueEnd(text, start);
    if (end === start) continue;
    output += `${text.slice(last, start)}${REDACTED}`;
    last = end;
  }
  return output + text.slice(last);
}

function namedValueEnd(text: string, start: number): number {
  let end = start;
  const quote = text.startsWith('\\"', start) ? '\\"' : text[start] === '"' || text[start] === "'" ? text[start] : null;
  if (quote) {
    const close = text.indexOf(quote, start + quote.length);
    end = close === -1 ? text.length : close + quote.length;
  } else {
    BARE_VALUE.lastIndex = start;
    end = start + (BARE_VALUE.exec(text)?.[0].length ?? 0);
  }
  return end;
}

/** CSV content: two or more lines that each hold a comma. */
function isCsvContent(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  return lines.length >= 2 && lines.filter((line) => line.includes(",")).length >= 2;
}

/** `text` without any secret it holds. Addresses, digests and object IDs are public and stay. */
export function redactPresaleText(text: string): string {
  if (isCsvContent(text)) return REDACTED;
  const patterned = SECRET_PATTERNS.reduce((current, pattern) => current.replace(pattern, REDACTED), text);
  return redactNamedValues(redactKeystoreKeys(patterned));
}

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return redactPresaleText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 4) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, isSecretName(key) ? REDACTED : redactValue(item, depth + 1)]),
  );
}

/**
 * A copy of log or metric fields that is safe to write: a field named for a
 * secret is replaced whatever its value, and every string loses any secret
 * shape it holds. Nesting deeper than four levels is dropped.
 */
export function redactPresaleFields<Fields extends Record<string, unknown>>(fields: Fields): Record<keyof Fields, unknown> {
  return redactValue(fields, 0) as Record<keyof Fields, unknown>;
}

/** `recordMetric` for presale code: the fields are redacted before the line is written. */
export function recordPresaleMetric(name: string, fields: MetricFields = {}): void {
  recordMetric(name, redactPresaleFields(fields) as MetricFields);
}
