/** Short windows share workspace overflow; tall desktop Data keeps its own list. */
export function workspaceScrollOwner(element: HTMLElement): HTMLElement {
  const workspace = element.closest<HTMLElement>("[data-workspace-scroll]");
  return workspace && window.getComputedStyle(workspace).overflowY === "auto" && window.getComputedStyle(element).overflowY === "visible" ? workspace : element;
}
