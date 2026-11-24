import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";

/** `blast_ak_` and 43 base64url characters: 32 random bytes. */
const API_KEY = /^blast_ak_[A-Za-z0-9_-]{43}$/;

/** A new agent API key. Only its SHA-256 is ever stored; the operator sees the key once. */
export function generatePresaleApiKey(): string {
  return `blast_ak_${randomBytes(32).toString("base64url")}`;
}

/** Whether `value` has an API key's shape: a cheap refusal before any database read. */
export function isPresaleApiKey(value: string): boolean {
  return z.string().regex(API_KEY).safeParse(value).success;
}

/** The stored form of a key: SHA-256 of the whole key, 32 bytes. */
export function hashPresaleApiKey(key: string): Buffer {
  return createHash("sha256").update(key, "utf8").digest();
}
