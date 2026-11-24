import assert from "node:assert/strict";
import test from "node:test";
import type { ClipboardEvent, DragEvent, FormEvent } from "react";

import { decimalText, dropDecimal, pasteDecimal } from "./decimal-input.ts";

const field = (value: string, start = value.length, end = start) => ({ value, selectionStart: start, selectionEnd: end }) as HTMLInputElement;

const typed = (value: string, data: string | null, caret = value.length, replacement?: string) =>
  decimalText({ currentTarget: field(value, caret), nativeEvent: { data, dataTransfer: replacement === undefined ? null : { getData: () => replacement } } } as unknown as FormEvent<HTMLInputElement>);

const pasted = (value: string, text: string, start = 0, end = value.length) => {
  let applied: string | null = null;
  let prevented = false;
  pasteDecimal({ currentTarget: field(value, start, end), clipboardData: { getData: () => text }, preventDefault: () => { prevented = true; } } as unknown as ClipboardEvent<HTMLInputElement>, (text) => { applied = text; });
  return { applied, prevented };
};

// Fails if a comma-decimal keypad's comma is dropped (#1033), or if the field's own grouping is re-read when a digit is typed after it.
test("decimalText reads only the typed text at the caret", () => {
  assert.equal(typed("0,", ","), "0.");
  assert.equal(typed("1,000,", ","), "1,000.");
  assert.equal(typed("1,0005", "5"), "1,0005");
  assert.equal(typed("1,0", ",", 2), "1.0");
  assert.equal(typed("1,000", null), "1,000", "a deletion has no data");
  assert.equal(typed("1,0", ",", 3), "1,0", "data that does not end at the caret is left alone");
  assert.equal(typed("2,5", null, 3, "2,5"), "2.5", "Safari's replacement text comes in dataTransfer");
  assert.equal(typed("1,000", null, 5, "000"), "1,000", "a replacement without a comma keeps the field's grouping");
});

// Fails if a paste is read against the text it replaces (`500` → `1,500` must be 1500, `1,000` → `1,5` must be 1.5).
test("pasteDecimal reads the pasted text over the real selection", () => {
  assert.deepEqual(pasted("500", "1,500"), { applied: "1500", prevented: true });
  assert.deepEqual(pasted("1,000", "1,5"), { applied: "1.5", prevented: true });
  assert.deepEqual(pasted("1,000", "1,000,000"), { applied: "1000000", prevented: true });
  assert.deepEqual(pasted("", "0,5"), { applied: "0.5", prevented: true });
  assert.deepEqual(pasted("12", "5"), { applied: null, prevented: false }, "a paste without a comma is the browser's");
});

const dropped = (value: string, text: string, selected?: readonly [number, number]) => {
  let applied: string | null = null;
  let prevented = false;
  const [start, end] = selected ?? [value.length, value.length];
  const input: Record<string, unknown> = { value, selectionStart: start, selectionEnd: end, focus: () => undefined };
  input.ownerDocument = { activeElement: selected ? input : null };
  dropDecimal({ currentTarget: input, dataTransfer: { getData: () => text }, preventDefault: () => { prevented = true; } } as unknown as DragEvent<HTMLInputElement>, (text) => { applied = text; });
  return { applied, prevented };
};

// Fails if a dragged-in `0,5` reads as 5, or a dropped amount is read against the grouping of the text it replaces.
test("dropDecimal replaces the field with the dropped amount, read by the same rule", () => {
  assert.deepEqual(dropped("", "0,5"), { applied: "0.5", prevented: true });
  assert.deepEqual(dropped("1,000", "1,5"), { applied: "1.5", prevented: true });
  assert.deepEqual(dropped("500", " 1,500 "), { applied: "1500", prevented: true });
  assert.deepEqual(dropped("12", "5"), { applied: null, prevented: false }, "a drop without a comma is the browser's");
  assert.deepEqual(dropped("12", "Hello, world"), { applied: null, prevented: false }, "a drop with no digit is the browser's");
  assert.deepEqual(dropped("12,345", ",3", [2, 4]), { applied: null, prevented: false }, "moving the field's own text keeps its grouping");
});
