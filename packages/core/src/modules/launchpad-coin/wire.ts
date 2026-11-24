/** Lossless, bounded transfer for the SSR coin read; never a partner API format. */
export const COIN_WIRE_MAX_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_NODES = 100_000;
const BIGINT_PATTERN = /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function invalid(): never {
  throw new Error("Invalid coin read wire value");
}

function validNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0) &&
    (!Number.isInteger(value) || Number.isSafeInteger(value));
}

function validKey(value: unknown): value is string {
  return typeof value === "string" && !UNSAFE_KEYS.has(value);
}

function budget() {
  let nodes = 0;
  return (depth: number) => {
    if (depth > MAX_DEPTH || ++nodes > MAX_NODES) invalid();
  };
}

/** Tagged values cannot collide with user strings or object properties. */
export function encodeCoinWire(value: unknown): string {
  const chunks: string[] = [];
  const ancestors = new Set<object>();
  const visit = budget();
  let bytes = 0;
  function append(chunk: string) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > COIN_WIRE_MAX_BYTES) invalid();
    chunks.push(chunk);
  }
  function string(value: string) {
    if (value.length > COIN_WIRE_MAX_BYTES) invalid();
    append(JSON.stringify(value));
  }
  function object(value: object, depth: number) {
    if (ancestors.has(value)) invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) invalid();
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        append('["array",[');
        if (value.length > MAX_NODES || Object.keys(value).length !== value.length) invalid();
        for (let index = 0; index < value.length; index++) {
          if (!Object.hasOwn(value, index)) invalid();
          if (index) append(",");
          encode(value[index], depth + 1);
        }
        append("]]");
        return;
      }
      const keys = Object.keys(value);
      if (keys.length > MAX_NODES) invalid();
      append('["object",[');
      keys.forEach((key, index) => {
        if (!validKey(key)) invalid();
        if (index) append(",");
        append("["); string(key); append(",");
        encode((value as Record<string, unknown>)[key], depth + 1);
        append("]");
      });
      append("]]");
    } finally {
      ancestors.delete(value);
    }
  }
  function encode(value: unknown, depth: number): void {
    visit(depth);
    if (value === null) { append('["null"]'); return; }
    if (typeof value === "string") { append('["string",'); string(value); append("]"); return; }
    if (typeof value === "boolean") { append(`["boolean",${value}]`); return; }
    if (typeof value === "number") {
      if (!validNumber(value)) invalid();
      append(`["number",${value}]`); return;
    }
    if (typeof value === "bigint") {
      const decimal = value.toString();
      if (decimal.length > 1024) invalid();
      append(`["bigint","${decimal}"]`); return;
    }
    if (value instanceof Uint8Array && value.constructor === Uint8Array) {
      if (value.byteLength > COIN_WIRE_MAX_BYTES / 2) invalid();
      append('["bytes",'); string(Buffer.from(value).toString("base64")); append("]"); return;
    }
    if (typeof value !== "object") invalid();
    object(value, depth);
  }
  append('["blast.coin-read.v1",');
  encode(value, 0);
  append("]");
  return chunks.join("");
}

function decodeBytes(value: unknown): Uint8Array {
  if (typeof value !== "string" || value.length > COIN_WIRE_MAX_BYTES ||
      value.length % 4 !== 0) invalid();
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || bytes.length > COIN_WIRE_MAX_BYTES / 2) invalid();
  return Uint8Array.from(bytes);
}

function decodeBigint(value: unknown): bigint {
  if (typeof value !== "string" || value.length > 1024 || !BIGINT_PATTERN.test(value)) invalid();
  return BigInt(value);
}

export function decodeCoinWire(text: string): unknown {
  if (Buffer.byteLength(text) > COIN_WIRE_MAX_BYTES) invalid();
  const envelope: unknown = JSON.parse(text);
  if (!Array.isArray(envelope) || envelope.length !== 2 || envelope[0] !== "blast.coin-read.v1") invalid();
  const visit = budget();
  function object(entries: unknown, depth: number): Record<string, unknown> {
    if (!Array.isArray(entries)) invalid();
    const result: Record<string, unknown> = {};
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2 || !validKey(entry[0]) || Object.hasOwn(result, entry[0])) invalid();
      Object.defineProperty(result, entry[0], { value: decode(entry[1], depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return result;
  }
  function decode(value: unknown, depth: number): unknown {
    visit(depth);
    if (!Array.isArray(value) || typeof value[0] !== "string") invalid();
    const [tag, data] = value;
    if (tag === "null") { if (value.length !== 1) invalid(); return null; }
    if (value.length !== 2) invalid();
    switch (tag) {
      case "string": if (typeof data !== "string") invalid(); return data;
      case "boolean": if (typeof data !== "boolean") invalid(); return data;
      case "number": if (!validNumber(data)) invalid(); return data;
      case "bigint": return decodeBigint(data);
      case "bytes": return decodeBytes(data);
      case "array": if (!Array.isArray(data)) invalid(); return data.map(item => decode(item, depth + 1));
      case "object": return object(data, depth);
      default: return invalid();
    }
  }
  return decode(envelope[1], 0);
}
