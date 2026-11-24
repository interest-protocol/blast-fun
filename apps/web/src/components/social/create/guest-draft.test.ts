import assert from "node:assert/strict";
import test from "node:test";
import { blankDraft } from "@blast/core/modules/social/create/model.ts";
import { createStore, persistGuestDraft } from "./create-store.ts";
import { GUEST_DRAFT_KEY, RETAINED_GUEST_DRAFT_KEY, GUEST_DRAFT_SCHEMA, GUEST_DRAFT_MAX_BYTES, restoreGuestDraft, importGuestDraft, writeGuestDraft, acknowledgeGuestDraft, GuestDraftStorageError, guestSourceDigest, guestDraftSource, GUEST_DRAFT_ACKNOWLEDGED_KEY } from "./guest-draft-storage.ts";

function fixture() {
  const records = new Map<string, string>();
  const storage = { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value); }, removeItem: (key: string) => { records.delete(key); } };
  return { records, storage };
}

test("guest restore distinguishes empty, canonical, retained, invalid, conflict and unavailable storage without mutating bytes", () => {
  const { records, storage } = fixture();
  assert.equal(restoreGuestDraft(storage).status, "empty");
  const envelope = JSON.stringify({ schema: GUEST_DRAFT_SCHEMA, version: 1, draft: blankDraft() });
  records.set(GUEST_DRAFT_KEY, envelope);
  const canonical = restoreGuestDraft(storage);
  assert.equal(canonical.status, "canonical");
  if (canonical.status === "canonical") assert.deepEqual(canonical.draft, blankDraft());
  records.set(RETAINED_GUEST_DRAFT_KEY, "  { retained private bytes\n");
  const conflict = restoreGuestDraft(storage);
  assert.equal(conflict.status, "recovery_required");
  if (conflict.status === "recovery_required") assert.equal(conflict.reason, "conflict");
  records.delete(GUEST_DRAFT_KEY);
  assert.equal(restoreGuestDraft(storage).status, "recovery_required");
  assert.equal(records.get(RETAINED_GUEST_DRAFT_KEY), "  { retained private bytes\n");
  records.delete(RETAINED_GUEST_DRAFT_KEY);
  records.set(GUEST_DRAFT_KEY, "{");
  assert.equal(restoreGuestDraft(storage).status, "recovery_required");
  assert.equal(records.get(GUEST_DRAFT_KEY), "{");
  assert.equal(restoreGuestDraft({ getItem() { throw new Error("private storage detail"); } }).status, "storage_error");
});

test("unversioned canonical and old recipient bodies remain opaque; import only accepts canonical envelopes", () => {
  const { records, storage } = fixture();
  const canonical = blankDraft();
  const old = { ...canonical, token_recipients: [{ label: "", address: "", bps: 0, vest: false, cliff_months: 0, months: 12 }] };
  for (const body of [canonical, old]) {
    const raw = `  ${JSON.stringify(body)}\n`;
    records.set(RETAINED_GUEST_DRAFT_KEY, raw);
    const previous = restoreGuestDraft(storage);
    assert.equal(previous.status, "recovery_required");
    if (previous.status !== "recovery_required") throw new Error("fixture");
    const saved = [...records];
    assert.throws(() => importGuestDraft(storage, JSON.stringify({ schema: GUEST_DRAFT_SCHEMA, version: 1, draft: old }), previous.snapshot), (error) => error instanceof GuestDraftStorageError && error.code === "invalid_file");
    assert.deepEqual([...records], saved);
    const imported = importGuestDraft(storage, JSON.stringify({ schema: GUEST_DRAFT_SCHEMA, version: 1, draft: canonical, recovered_from: guestSourceDigest(raw) }), previous.snapshot);
    assert.equal(imported.status, "canonical");
    assert.equal(records.get(RETAINED_GUEST_DRAFT_KEY), raw);
    if (imported.status !== "canonical") throw new Error("fixture");
    assert.equal(imported.recoveredFrom, guestSourceDigest(raw));
    assert.deepEqual(restoreGuestDraft(storage), imported, "crash after envelope write retains recoverable source receipt");
    records.delete(GUEST_DRAFT_KEY);
  }
});

test("import without retained source makes no retained-source recovery claim", () => {
  const { storage } = fixture();
  const empty = restoreGuestDraft(storage);
  if (empty.status !== "empty") throw new Error("fixture");
  const raw = JSON.stringify({ schema: GUEST_DRAFT_SCHEMA, version: 1, draft: blankDraft() });
  const imported = importGuestDraft(storage, raw, empty.snapshot);
  assert.equal(imported.status, "canonical");
  if (imported.status === "canonical") assert.equal(imported.recoveredFrom, null);
});

test("changed raw bytes, two copies and newer canonical drafts refuse import/write/acknowledgement without mutation", () => {
  const { records, storage } = fixture();
  records.set(RETAINED_GUEST_DRAFT_KEY, "retained");
  const old = restoreGuestDraft(storage);
  if (old.status !== "recovery_required") throw new Error("fixture");
  const raw = JSON.stringify({ schema: GUEST_DRAFT_SCHEMA, version: 1, draft: blankDraft(), recovered_from: guestSourceDigest("retained") });
  records.set(RETAINED_GUEST_DRAFT_KEY, "newer retained");
  assert.throws(() => importGuestDraft(storage, raw, old.snapshot), (error) => error instanceof GuestDraftStorageError && error.code === "changed");
  records.set(RETAINED_GUEST_DRAFT_KEY, "retained");
  const canonical = importGuestDraft(storage, raw, old.snapshot);
  if (canonical.status !== "canonical") throw new Error("fixture");
  assert.throws(() => importGuestDraft(storage, raw, canonical.snapshot), (error) => error instanceof GuestDraftStorageError && error.code === "conflict");
  records.set(GUEST_DRAFT_KEY, "another canonical file");
  const saved = [...records];
  assert.throws(() => writeGuestDraft(storage, canonical, blankDraft()), (error) => error instanceof GuestDraftStorageError && error.code === "changed");
  assert.throws(() => acknowledgeGuestDraft(storage, canonical, guestDraftSource(canonical)), (error) => error instanceof GuestDraftStorageError && error.code === "changed");
  assert.deepEqual([...records], saved);
  assert.equal(restoreGuestDraft(storage).status, "recovery_required");
});

test("quota errors and readback mismatches do not adopt or delete the retained source", () => {
  const { records, storage } = fixture();
  records.set(RETAINED_GUEST_DRAFT_KEY, "source bytes");
  const previous = restoreGuestDraft(storage);
  if (previous.status !== "recovery_required") throw new Error("fixture");
  const raw = JSON.stringify({ schema: GUEST_DRAFT_SCHEMA, version: 1, draft: blankDraft(), recovered_from: guestSourceDigest("source bytes") });
  for (const broken of [
    { ...storage, setItem() { throw new Error("private quota detail"); } },
    { ...storage, setItem() {} },
  ]) {
    assert.throws(() => importGuestDraft(broken, raw, previous.snapshot), (error) => error instanceof GuestDraftStorageError && error.code === "storage_error" && !error.message.includes("private"));
    assert.equal(records.get(RETAINED_GUEST_DRAFT_KEY), "source bytes");
    assert.equal(records.has(GUEST_DRAFT_KEY), false);
  }
});

test("missing or unrelated recovery receipt cannot claim a retained source or mutate storage", () => {
  const { records, storage } = fixture();
  records.set(RETAINED_GUEST_DRAFT_KEY, "private exact source bytes");
  const previous = restoreGuestDraft(storage);
  if (previous.status !== "recovery_required") throw new Error("fixture");
  for (const receipt of [undefined, guestSourceDigest("unrelated input")]) {
    const raw = JSON.stringify({ schema: GUEST_DRAFT_SCHEMA, version: 1, draft: blankDraft(), ...(receipt === undefined ? {} : { recovered_from: receipt }) });
    assert.throws(() => importGuestDraft(storage, raw, previous.snapshot), (error) => error instanceof GuestDraftStorageError && error.code === "invalid_file");
    assert.deepEqual([...records], [[RETAINED_GUEST_DRAFT_KEY, "private exact source bytes"]]);
  }
});

test("guest writes enforce the same size limit as restore without destroying a previous copy", () => {
  const { records, storage } = fixture();
  const empty = restoreGuestDraft(storage);
  const before = [...records];
  assert.throws(() => writeGuestDraft(storage, empty, { ...blankDraft(), name: "x".repeat(GUEST_DRAFT_MAX_BYTES) }), (error) => error instanceof GuestDraftStorageError && error.code === "invalid_file");
  assert.deepEqual([...records], before);
});

test("OAuth persistence uses canonical envelopes and never infers a guest save acknowledgement from an account version", () => {
  const { records, storage } = fixture();
  createStore.reset({ phase: "visitor" });
  createStore.edit((draft) => ({ ...draft, name: "Unsigned token", symbol: "NEW" }));
  const guest = persistGuestDraft(storage, createStore.get(), restoreGuestDraft(storage), false);
  assert.equal(guest.status, "canonical");
  assert.equal(records.has(RETAINED_GUEST_DRAFT_KEY), false);
  if (guest.status === "canonical") assert.deepEqual(guest.draft, createStore.get().draft);
  createStore.set({ ownerId: "existing-account", version: 7 });
  const copies = [...records];
  persistGuestDraft(storage, createStore.get(), guest, false);
  assert.deepEqual([...records], copies, "unrelated account save must not delete a guest backup");
  persistGuestDraft(storage, createStore.get(), guest, true);
  assert.deepEqual([...records], copies, "even an adopted flag cannot acknowledge a different account save");
  acknowledgeGuestDraft(storage, guest, guestDraftSource(guest));
  assert.equal(records.size, 0, "acknowledged adopted guest save may clear only matching canonical copy");
  records.set(RETAINED_GUEST_DRAFT_KEY, "raw unresolved");
  const unresolved = restoreGuestDraft(storage);
  persistGuestDraft(storage, createStore.get(), unresolved, true);
  createStore.set({ ownerId: null, version: 0, dirty: true });
  persistGuestDraft(storage, createStore.get(), unresolved, false);
  assert.deepEqual([...records], [[RETAINED_GUEST_DRAFT_KEY, "raw unresolved"]]);
  createStore.reset();
});


test("a partial browser cleanup after account save cannot offer the surviving copy for adoption again", () => {
  const { records, storage } = fixture();
  records.set(RETAINED_GUEST_DRAFT_KEY, "exact source");
  const before = restoreGuestDraft(storage);
  if (before.status !== "recovery_required") throw new Error("fixture");
  const imported = importGuestDraft(storage, JSON.stringify({ schema: GUEST_DRAFT_SCHEMA, version: 1, draft: blankDraft(), recovered_from: guestSourceDigest("exact source") }), before.snapshot);
  const partial = { ...storage, removeItem(key: string) { if (key === GUEST_DRAFT_KEY) throw new Error("cleanup unavailable"); storage.removeItem(key); } };
  try { acknowledgeGuestDraft(partial, imported, guestDraftSource(imported)); } catch { /* Account save already succeeded. */ }
  assert.equal(records.has(RETAINED_GUEST_DRAFT_KEY), false);
  assert.equal(records.has(GUEST_DRAFT_KEY), true);
  assert.equal(restoreGuestDraft(storage).status, "acknowledged", "surviving copy must remember the successful account save across reload");
});


test("acknowledgement is bound to the adopted source and refuses another restored file", () => {
  const { records, storage } = fixture();
  const first = writeGuestDraft(storage, restoreGuestDraft(storage), blankDraft());
  const source = guestDraftSource(first);
  const next = writeGuestDraft(storage, first, { ...blankDraft(), name: "Different copy" });
  const before = [...records];
  assert.throws(() => acknowledgeGuestDraft(storage, next, source), (error) => error instanceof GuestDraftStorageError && error.code === "changed");
  assert.deepEqual([...records], before);
});

test("acknowledgement write refusal never removes either backup; malformed and mismatched receipts never authorize adoption or deletion", () => {
  const { records, storage } = fixture();
  records.set(RETAINED_GUEST_DRAFT_KEY, "two-copy source");
  const previous = restoreGuestDraft(storage);
  if (previous.status !== "recovery_required") throw new Error("fixture");
  const guest = importGuestDraft(storage, JSON.stringify({ schema: GUEST_DRAFT_SCHEMA, version: 1, draft: blankDraft(), recovered_from: guestSourceDigest("two-copy source") }), previous.snapshot);
  if (guest.status !== "canonical") throw new Error("fixture");
  const before = [...records];
  const refuses = { ...storage, setItem() { throw new Error("quota"); } };
  assert.throws(() => acknowledgeGuestDraft(refuses, guest, guestDraftSource(guest)), (error) => error instanceof GuestDraftStorageError && error.code === "storage_error");
  assert.deepEqual([...records], before);
  for (const marker of ["{", JSON.stringify({ retained: null, canonical: guestSourceDigest("unrelated") })]) {
    records.set(GUEST_DRAFT_ACKNOWLEDGED_KEY, marker);
    assert.equal(restoreGuestDraft(storage).status, "recovery_required");
    assert.equal(records.get(GUEST_DRAFT_KEY), guest.snapshot.canonicalRaw);
  }
});

test("a durable save receipt protects both copies when the first removal fails and blocks stale guest writes", () => {
  const { records, storage } = fixture();
  records.set(RETAINED_GUEST_DRAFT_KEY, "retained bytes");
  const old = restoreGuestDraft(storage);
  if (old.status !== "recovery_required") throw new Error("fixture");
  const guest = importGuestDraft(storage, JSON.stringify({ schema: GUEST_DRAFT_SCHEMA, version: 1, draft: blankDraft(), recovered_from: guestSourceDigest("retained bytes") }), old.snapshot);
  const refuses = { ...storage, removeItem() { throw new Error("remove failed"); } };
  assert.equal(acknowledgeGuestDraft(refuses, guest, guestDraftSource(guest)).status, "acknowledged");
  assert.equal(restoreGuestDraft(storage).status, "acknowledged");
  const saved = [...records];
  assert.throws(() => writeGuestDraft(storage, guest, blankDraft()), (error) => error instanceof GuestDraftStorageError && error.code === "changed");
  assert.deepEqual([...records], saved);
});

test("a receipt left after both copies were removed cannot acknowledge a newly written identical draft", () => {
  const { records, storage } = fixture();
  records.set(RETAINED_GUEST_DRAFT_KEY, "two-copy source");
  const previous = restoreGuestDraft(storage);
  if (previous.status !== "recovery_required") throw new Error("fixture");
  const guest = importGuestDraft(storage, JSON.stringify({ schema: GUEST_DRAFT_SCHEMA, version: 1, draft: blankDraft(), recovered_from: guestSourceDigest("two-copy source") }), previous.snapshot);
  if (guest.status !== "canonical") throw new Error("fixture");
  const refusesMarkerRemoval = { ...storage, removeItem(key: string) { if (key === GUEST_DRAFT_ACKNOWLEDGED_KEY) throw new Error("receipt cleanup failed"); storage.removeItem(key); } };
  assert.equal(acknowledgeGuestDraft(refusesMarkerRemoval, guest, guestDraftSource(guest)).status, "empty");
  assert.equal(records.has(GUEST_DRAFT_ACKNOWLEDGED_KEY), true);
  const next = writeGuestDraft(storage, restoreGuestDraft(storage), blankDraft());
  assert.equal(next.status, "canonical");
  assert.equal(restoreGuestDraft(storage).status, "canonical");
  assert.equal(records.has(GUEST_DRAFT_ACKNOWLEDGED_KEY), false);
});


test("a save of one recovered envelope cannot acknowledge a different envelope carrying the same source receipt", () => {
  const { records, storage } = fixture();
  records.set(RETAINED_GUEST_DRAFT_KEY, "one retained source");
  const previous = restoreGuestDraft(storage);
  if (previous.status !== "recovery_required") throw new Error("fixture");
  const first = importGuestDraft(storage, JSON.stringify({ schema: GUEST_DRAFT_SCHEMA, version: 1, draft: blankDraft(), recovered_from: guestSourceDigest("one retained source") }), previous.snapshot);
  const adoptedSource = guestDraftSource(first);
  const next = writeGuestDraft(storage, first, { ...blankDraft(), name: "New unsaved recovered copy" });
  if (first.status !== "canonical" || next.status !== "canonical") throw new Error("fixture");
  assert.equal(first.recoveredFrom, next.recoveredFrom, "both envelopes refer to the same retained source");
  const before = [...records];
  assert.throws(() => acknowledgeGuestDraft(storage, next, adoptedSource), (error) => error instanceof GuestDraftStorageError && error.code === "changed");
  assert.deepEqual([...records], before, "different canonical bytes and their source must remain intact");
});


test("a single saved canonical copy clears under write quota without requiring an acknowledgement marker", () => {
  const { records, storage } = fixture();
  const guest = writeGuestDraft(storage, restoreGuestDraft(storage), blankDraft());
  let writes = 0;
  const refusesWrites = { ...storage, setItem() { writes++; throw new Error("quota"); } };
  assert.equal(acknowledgeGuestDraft(refusesWrites, guest, guestDraftSource(guest)).status, "empty");
  assert.equal(writes, 0);
  assert.equal(records.has(GUEST_DRAFT_KEY), false);
  assert.equal(restoreGuestDraft(storage).status, "empty", "A reload cannot revive an atomically removed copy");
});

test("single-copy quota cleanup still refuses a changed canonical snapshot", () => {
  const { records, storage } = fixture();
  const guest = writeGuestDraft(storage, restoreGuestDraft(storage), blankDraft());
  const newer = writeGuestDraft(storage, guest, { ...blankDraft(), name: "New unsaved browser work" });
  if (newer.status !== "canonical") throw new Error("fixture");
  const refusesWrites = { ...storage, setItem() { throw new Error("quota"); } };
  assert.throws(() => acknowledgeGuestDraft(refusesWrites, guest, guestDraftSource(guest)), (error) => error instanceof GuestDraftStorageError && error.code === "changed");
  assert.equal(records.get(GUEST_DRAFT_KEY), newer.snapshot.canonicalRaw);
});
