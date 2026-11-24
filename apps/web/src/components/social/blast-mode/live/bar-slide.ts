/** Fill updates use CSSOM for CSP, and leave the track's geometry unchanged: a progress change, a short slide (the figures beside it update at once). */
export const BAR_SLIDE = "transform var(--t3) var(--ease-std)";

export function slideBarFill(element: Readonly<{ style: Pick<CSSStyleDeclaration, "transform" | "transition"> }>, percent: number): void {
  const scale = Math.round(Math.max(0, Math.min(100, percent)) * 100) / 10_000;
  const transform = `scaleX(${scale})`;
  const was = element.style.transform;
  if (was === transform) return;
  if (was !== "") element.style.transition = BAR_SLIDE;
  element.style.transform = transform;
}
