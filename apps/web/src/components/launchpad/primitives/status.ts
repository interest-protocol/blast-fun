/** Semantic directions and cautions. Color only reinforces the word and shape. */
export const STATUS_TONES = ["up", "down", "flat", "caution"] as const;
export type StatusTone = (typeof STATUS_TONES)[number];

export type StatusGlyph = "triangle-up" | "triangle-down" | "bar" | "diamond";

const PRESENTATION: Record<StatusTone, Readonly<{ word: string; glyph: StatusGlyph }>> = {
  up: { word: "Up", glyph: "triangle-up" },
  down: { word: "Down", glyph: "triangle-down" },
  flat: { word: "Unchanged", glyph: "bar" },
  caution: { word: "Caution", glyph: "diamond" },
};

export function statusPresentation(tone: StatusTone) {
  return PRESENTATION[tone];
}

/** The direction of a change; null when the change is not known. */
export function changeTone(change: number | null): StatusTone | null {
  if (change === null || Number.isNaN(change)) return null;
  if (change > 0) return "up";
  if (change < 0) return "down";
  return "flat";
}
