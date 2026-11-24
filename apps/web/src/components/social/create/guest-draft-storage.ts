import type { CreateDraft } from "@blast/core/web/contracts/create.ts";
import { parseDraft } from "@blast/core/modules/social/create/model.ts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

export const GUEST_DRAFT_KEY = "blast:create:guest-draft:v1";
export const RETAINED_GUEST_DRAFT_KEY = "blast:create:guest-draft";
export const GUEST_DRAFT_SCHEMA = "blast.social-create-guest-draft";
export const GUEST_DRAFT_ACKNOWLEDGED_KEY = "blast:create:guest-draft:acknowledged:v1";
export type GuestDraftSnapshot = Readonly<{
  retainedRaw: string | null;
  canonicalRaw: string | null;
}>;
export type GuestDraftRestore =
  | Readonly<{ status: "empty"; snapshot: GuestDraftSnapshot }>
  | Readonly<{ status: "acknowledged"; snapshot: GuestDraftSnapshot }>
  | Readonly<{
      status: "canonical";
      snapshot: GuestDraftSnapshot;
      draft: CreateDraft;
      recoveredFrom: string | null;
    }>
  | Readonly<{
      status: "recovery_required";
      snapshot: GuestDraftSnapshot;
      reason: "retained" | "invalid" | "conflict" | "changed";
    }>
  | Readonly<{ status: "storage_error" }>;
export type GuestStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export const GUEST_DRAFT_MAX_BYTES = 1_048_576;
export class GuestDraftStorageError extends Error {
  readonly code: "invalid_file" | "changed" | "conflict" | "storage_error";
  constructor(code: "invalid_file" | "changed" | "conflict" | "storage_error") {
    super(`Guest draft recovery failed: ${code}`);
    this.name = "GuestDraftStorageError";
    this.code = code;
  }
}

export function guestSourceDigest(raw: string): string {
  return bytesToHex(sha256(utf8ToBytes(raw)));
}

/** Identity of both exact browser copies explicitly adopted into an account draft. */
export function guestDraftSource(restored: GuestDraftRestore): string | null {
  if (restored.status !== "canonical") return null;
  return guestSourceDigest(JSON.stringify(snapshotDigests(restored.snapshot)));
}

function snapshotDigests(snapshot: GuestDraftSnapshot) {
  return {
    retained: snapshot.retainedRaw === null ? null : guestSourceDigest(snapshot.retainedRaw),
    canonical: snapshot.canonicalRaw === null ? null : guestSourceDigest(snapshot.canonicalRaw),
  };
}

function matchesAcknowledgement(raw: string, snapshot: GuestDraftSnapshot): boolean {
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const marker = value as Record<string, unknown>;
    if (Object.keys(marker).length !== 2 || !Object.hasOwn(marker, "retained") || !Object.hasOwn(marker, "canonical")) return false;
    if (typeof marker.canonical !== "string" || !/^[a-f0-9]{64}$/.test(marker.canonical)) return false;
    if (marker.retained !== null && (typeof marker.retained !== "string" || !/^[a-f0-9]{64}$/.test(marker.retained))) return false;
    const current = snapshotDigests(snapshot);
    return (current.retained === null || current.retained === marker.retained) &&
      (current.canonical === null || current.canonical === marker.canonical);
  } catch {
    return false;
  }
}

function snapshotOf(storage: Pick<Storage, "getItem">): GuestDraftSnapshot {
  return {
    retainedRaw: storage.getItem(RETAINED_GUEST_DRAFT_KEY),
    canonicalRaw: storage.getItem(GUEST_DRAFT_KEY),
  };
}

function envelopeOf(raw: string): {
  draft: CreateDraft;
  recoveredFrom: string | null;
} {
  if (utf8ToBytes(raw).length > GUEST_DRAFT_MAX_BYTES)
    throw new Error("invalid_envelope");
  const value: unknown = JSON.parse(raw);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_envelope");
  const envelope = value as Record<string, unknown>;
  if (
    envelope.schema !== GUEST_DRAFT_SCHEMA ||
    envelope.version !== 1 ||
    !Object.hasOwn(envelope, "draft") ||
    !Object.keys(envelope).every((key) =>
      ["schema", "version", "draft", "recovered_from"].includes(key),
    )
  )
    throw new Error("invalid_envelope");
  const recoveredFrom = envelope.recovered_from;
  if (
    recoveredFrom !== undefined &&
    (typeof recoveredFrom !== "string" || !/^[a-f0-9]{64}$/.test(recoveredFrom))
  )
    throw new Error("invalid_envelope");
  return {
    draft: parseDraft(envelope.draft),
    recoveredFrom: (recoveredFrom as string | undefined) ?? null,
  };
}

function requireSnapshot(
  storage: Pick<Storage, "getItem">,
  expected: GuestDraftSnapshot,
): void {
  let actual: GuestDraftSnapshot;
  try {
    actual = snapshotOf(storage);
  } catch {
    throw new GuestDraftStorageError("storage_error");
  }
  if (
    actual.retainedRaw !== expected.retainedRaw ||
    actual.canonicalRaw !== expected.canonicalRaw
  )
    throw new GuestDraftStorageError("changed");
}

function writeEnvelope(
  storage: GuestStorage,
  snapshot: GuestDraftSnapshot,
  draft: CreateDraft,
  recoveredFrom: string | null,
): GuestDraftRestore {
  requireSnapshot(storage, snapshot);
  const raw = JSON.stringify({
    schema: GUEST_DRAFT_SCHEMA,
    version: 1,
    draft,
    ...(recoveredFrom === null ? {} : { recovered_from: recoveredFrom }),
  });
  if (utf8ToBytes(raw).length > GUEST_DRAFT_MAX_BYTES)
    throw new GuestDraftStorageError("invalid_file");
  try {
    // An earlier cleanup may have left only its receipt. Clear it before a new draft is written.
    if (storage.getItem(GUEST_DRAFT_ACKNOWLEDGED_KEY) !== null &&
        (snapshot.retainedRaw !== null || snapshot.canonicalRaw !== null))
      throw new GuestDraftStorageError("changed");
    storage.removeItem(GUEST_DRAFT_ACKNOWLEDGED_KEY);
    if (storage.getItem(GUEST_DRAFT_ACKNOWLEDGED_KEY) !== null)
      throw new GuestDraftStorageError("storage_error");
    storage.setItem(GUEST_DRAFT_KEY, raw);
    if (storage.getItem(GUEST_DRAFT_KEY) !== raw)
      throw new GuestDraftStorageError("storage_error");
    if (storage.getItem(RETAINED_GUEST_DRAFT_KEY) !== snapshot.retainedRaw)
      throw new GuestDraftStorageError("changed");
  } catch (error) {
    throw error instanceof GuestDraftStorageError
      ? error
      : new GuestDraftStorageError("storage_error");
  }
  return {
    status: "canonical",
    snapshot: { retainedRaw: snapshot.retainedRaw, canonicalRaw: raw },
    draft,
    recoveredFrom,
  };
}

/** Explicit import only. Existing canonical copies are never overwritten by import. */
export function importGuestDraft(
  storage: GuestStorage,
  raw: string,
  expected: GuestDraftSnapshot,
): GuestDraftRestore {
  let imported: ReturnType<typeof envelopeOf>;
  try {
    imported = envelopeOf(raw);
  } catch {
    throw new GuestDraftStorageError("invalid_file");
  }
  requireSnapshot(storage, expected);
  if (expected.canonicalRaw !== null)
    throw new GuestDraftStorageError("conflict");
  const source =
    expected.retainedRaw === null
      ? null
      : guestSourceDigest(expected.retainedRaw);
  if (source !== null && imported.recoveredFrom !== source)
    throw new GuestDraftStorageError("invalid_file");
  return writeEnvelope(storage, expected, imported.draft, source);
}

/** Called only for a mounted guest draft. No hash work is performed while typing. */
export function writeGuestDraft(
  storage: GuestStorage,
  previous: GuestDraftRestore,
  draft: CreateDraft,
): GuestDraftRestore {
  if (previous.status !== "empty" && previous.status !== "canonical")
    throw new GuestDraftStorageError("conflict");
  return writeEnvelope(
    storage,
    previous.snapshot,
    draft,
    previous.status === "canonical" ? previous.recoveredFrom : null,
  );
}

/** After explicit adoption and an acknowledged account save, clear only its exact matching copies. */
export function acknowledgeGuestDraft(
  storage: GuestStorage,
  previous: GuestDraftRestore,
  expectedSource: string | null,
): GuestDraftRestore {
  if (previous.status !== "canonical") return previous;
  if (expectedSource === null || guestDraftSource(previous) !== expectedSource)
    throw new GuestDraftStorageError("changed");
  requireSnapshot(storage, previous.snapshot);
  try {
    if (previous.snapshot.retainedRaw !== null) {
      // Two copies need a durable receipt before either removal so partial cleanup cannot resurrect work.
      const marker = JSON.stringify(snapshotDigests(previous.snapshot));
      storage.setItem(GUEST_DRAFT_ACKNOWLEDGED_KEY, marker);
      if (storage.getItem(GUEST_DRAFT_ACKNOWLEDGED_KEY) !== marker)
        throw new GuestDraftStorageError("storage_error");
      requireSnapshot(storage, previous.snapshot);
      if (previous.recoveredFrom !== null) storage.removeItem(RETAINED_GUEST_DRAFT_KEY);
    }
    // A single canonical copy can be removed atomically even when quota prevents writing a receipt.
    storage.removeItem(GUEST_DRAFT_KEY);
    const snapshot = snapshotOf(storage);
    if (snapshot.retainedRaw !== null || snapshot.canonicalRaw !== null)
      return restoreGuestDraft(storage);
    storage.removeItem(GUEST_DRAFT_ACKNOWLEDGED_KEY);
    return { status: "empty", snapshot };
  } catch {
    const restored = restoreGuestDraft(storage);
    if (restored.status === "acknowledged" || restored.status === "empty") return restored;
    throw new GuestDraftStorageError("storage_error");
  }
}

export function restoreGuestDraft(
  storage: Pick<Storage, "getItem">,
): GuestDraftRestore {
  let snapshot: GuestDraftSnapshot;
  let acknowledged: string | null;
  try {
    snapshot = snapshotOf(storage);
    acknowledged = storage.getItem(GUEST_DRAFT_ACKNOWLEDGED_KEY);
  } catch {
    return { status: "storage_error" };
  }
  if (snapshot.retainedRaw === null && snapshot.canonicalRaw === null)
    return { status: "empty", snapshot };
  if (acknowledged !== null)
    return matchesAcknowledgement(acknowledged, snapshot)
      ? { status: "acknowledged", snapshot }
      : { status: "recovery_required", snapshot, reason: "changed" };
  if (snapshot.canonicalRaw === null)
    return snapshot.retainedRaw === null
      ? { status: "empty", snapshot }
      : { status: "recovery_required", snapshot, reason: "retained" };
  try {
    const envelope = envelopeOf(snapshot.canonicalRaw);
    if (
      snapshot.retainedRaw !== null &&
      envelope.recoveredFrom !== guestSourceDigest(snapshot.retainedRaw)
    ) {
      return { status: "recovery_required", snapshot, reason: "conflict" };
    }
    return { status: "canonical", snapshot, ...envelope };
  } catch {
    return {
      status: "recovery_required",
      snapshot,
      reason: snapshot.retainedRaw === null ? "invalid" : "conflict",
    };
  }
}
