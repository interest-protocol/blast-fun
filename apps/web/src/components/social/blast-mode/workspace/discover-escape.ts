/**
 * What an Escape keydown inside Discover does.
 * - An IME Escape (cancelling a candidate: composing, or Safari's keyCode 229) keeps the key.
 * - An editable text field with text is cleared here (not every browser clears type=search on Escape), so the next Escape closes.
 * - Anything else lets Discover close: a checkbox (its value is always "on") and a closed select too.
 *   An open select's list takes Escape itself, so no keydown reaches here (checked in Chromium only).
 */
export function escapeInDiscover(event: KeyboardEvent): "keep" | "cleared" | "close" {
  if (event.isComposing || event.keyCode === 229) return "keep";
  const element = event.target as HTMLElement | null;
  const field = element as HTMLInputElement | HTMLTextAreaElement | null;
  const text = element?.tagName === "TEXTAREA" || (element?.tagName === "INPUT" && TEXT_INPUT_TYPES.has((element as HTMLInputElement).type));
  if (!text || !field || field.readOnly || field.disabled || field.value === "") return "close";
  // Set through the prototype's setter so React's controlled input sees the change in its own input event.
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!.call(field, "");
  field.dispatchEvent(new field.ownerDocument.defaultView!.Event("input", { bubbles: true }));
  return "cleared";
}

const TEXT_INPUT_TYPES = new Set(["search", "text"]);
