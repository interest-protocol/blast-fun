/** Follow the visual viewport when a software keyboard leaves the layout viewport unchanged. */
export function bindSheetViewport(scrim: HTMLElement, viewport: VisualViewport): () => void {
  const update = () => {
    scrim.style.top = `${viewport.offsetTop}px`;
    scrim.style.bottom = "auto";
    scrim.style.height = `${viewport.height}px`;
    scrim.style.setProperty("--sheet-viewport-height", `${viewport.height}px`);
  };
  update();
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  return () => {
    viewport.removeEventListener("resize", update);
    viewport.removeEventListener("scroll", update);
    for (const property of ["top", "bottom", "height", "--sheet-viewport-height"]) scrim.style.removeProperty(property);
  };
}
