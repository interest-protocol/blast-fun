/**
 * The split shades, by place in the bar: ink, then a light grey, a dark grey
 * and a lighter grey, repeating. Each part that shows takes the next shade,
 * so neighbours alternate dark and light and always differ by 3:1 or more;
 * a part at zero takes the shade the next part would. The bar and its key
 * use the same list. Splits are neutral: ink and grey, never a hue.
 */
const SHADES = ["var(--ink)", "var(--ink-tint-2)", "var(--ink-tint-1)", "var(--ink-tint-3)"] as const;

export function splitShades(bps: readonly number[]): readonly string[] {
  let shown = 0;
  return bps.map((value) => {
    const shade = SHADES[shown % SHADES.length]!;
    if (Number.isFinite(value) && value > 0) shown += 1;
    return shade;
  });
}
