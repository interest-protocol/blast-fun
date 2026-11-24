import type { ClipboardEvent, DragEvent, FormEvent } from "react";
import { decimalPoint, insertDecimal } from "@blast/core/web/exact-amount.ts";

/**
 * An amount field's new text with a typed comma read as a decimal mark (#1033):
 * a comma-decimal phone keypad types `0,5`, which must never read as 5. Only the
 * typed or replacing text is read, from the input event and the caret, so the commas the
 * field already shows stay grouping.
 */
export function decimalText(event: FormEvent<HTMLInputElement>): string {
  const input = event.currentTarget;
  const native = event.nativeEvent as InputEvent;
  // Safari gives a replacement (autocorrect, a suggestion) in `dataTransfer`, not `data`.
  const typed = native.data ?? native.dataTransfer?.getData("text/plain") ?? null;
  if (!typed?.includes(",")) return input.value;
  const end = input.selectionEnd ?? input.value.length;
  const start = Math.max(0, end - typed.length);
  if (input.value.slice(start, end) !== typed) return input.value;
  return insertDecimal(input.value.slice(0, start) + input.value.slice(end), start, start, typed);
}

/**
 * Pastes with a comma go through `insertDecimal` over the real selection, so
 * `1,500` pasted over `500` is 1500 and `1,5` pasted over `1,000` is 1.5.
 * Pastes without a comma are left to the browser.
 */
export function pasteDecimal(event: ClipboardEvent<HTMLInputElement>, apply: (text: string) => void): void {
  const pasted = event.clipboardData.getData("text");
  if (!pasted.includes(",")) return;
  event.preventDefault();
  const input = event.currentTarget;
  apply(insertDecimal(input.value, input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length, pasted));
}

/**
 * Drops with a comma replace the field, read by `decimalPoint`: a drop has no
 * caret to insert at, and an amount dragged into an amount field is the amount
 * meant. Drops without a comma or a digit, and moves of the field's own text,
 * are left to the browser.
 */
export function dropDecimal(event: DragEvent<HTMLInputElement>, apply: (text: string) => void): void {
  const dropped = event.dataTransfer.getData("text");
  if (!dropped.includes(",") || !/\d/.test(dropped)) return;
  const input = event.currentTarget;
  // A move of the field's own text keeps its commas as the grouping they are.
  if (input.ownerDocument.activeElement === input && input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0) === dropped) return;
  event.preventDefault();
  input.focus();
  apply(decimalPoint(dropped.trim()));
}
