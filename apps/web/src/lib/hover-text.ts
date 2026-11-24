const HOVER_TEXT_LIMIT = 64;

/** A short preview for clipped user text. The full text stays on the page or in its detail view. */
export function hoverExcerpt(value: string): string {
  const normalized = value.trim().replace(/\s+/gu, " ").replace(/\S{33,}/gu, (word) =>
    `${Array.from(word).slice(0, 24).join("")}…`);
  const text = Array.from(normalized);
  if (text.length <= HOVER_TEXT_LIMIT) {
    return text.join("");
  }
  const cutoff = text.slice(0, HOVER_TEXT_LIMIT - 1);
  const lastSpace = cutoff.lastIndexOf(" ");
  const end = lastSpace >= HOVER_TEXT_LIMIT / 2 ? lastSpace : cutoff.length;
  return `${cutoff.slice(0, end).join("").trimEnd()}…`;
}
