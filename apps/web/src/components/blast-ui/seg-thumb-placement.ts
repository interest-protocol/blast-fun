/** Puts `seg`'s thumb on its pressed button, selected tab or current link, 3px inset on every side. */
export function placeSegThumb(seg: HTMLElement | null): void {
  if (!seg) return;
  const thumb = seg.querySelector<HTMLElement>(".seg-ind");
  const pressed = seg.querySelector<HTMLElement>('button[aria-pressed="true"], button[role="tab"][aria-selected="true"], a[aria-current="page"]');
  if (!thumb) return;
  // No segment is current (the shown choice lives outside the row, as in Discover's More): no thumb, and the next one lands without sliding.
  if (!pressed) {
    thumb.style.visibility = "hidden";
    thumb.style.transform = "";
    return;
  }
  thumb.style.visibility = "";
  // The first placement lands without sliding in from the left edge; later ones glide.
  const first = !thumb.style.transform;
  if (first) thumb.style.transition = "none";
  thumb.style.width = `${pressed.offsetWidth}px`;
  thumb.style.transform = `translateX(${pressed.offsetLeft}px)`;
  if (first) {
    void thumb.offsetWidth;
    thumb.style.transition = "";
  }
}

/** Scrolls a row too narrow for its labels (a stretched `.seg`) so its selected segment is in view, without moving the page. */
export function revealSegSelection(seg: HTMLElement | null): void {
  if (!seg || seg.scrollWidth <= seg.clientWidth) return;
  const pressed = seg.querySelector<HTMLElement>('button[aria-pressed="true"], button[role="tab"][aria-selected="true"], a[aria-current="page"]');
  if (!pressed) return;
  const left = pressed.offsetLeft;
  const right = left + pressed.offsetWidth;
  if (left < seg.scrollLeft) seg.scrollLeft = left - 3;
  else if (right > seg.scrollLeft + seg.clientWidth) seg.scrollLeft = right - seg.clientWidth + 3;
}
