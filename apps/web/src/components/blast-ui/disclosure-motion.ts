import { instantFeedback } from "./feedback-motion";
import { EASE_OUT, T2 } from "./motion-tokens";

type DisclosureRun = {
  open: boolean;
  animation: Animation;
  finish: () => void;
};

/** Enhance native disclosures without replacing their semantics or requiring per-page wiring. */
export function installDisclosureMotion(root: Document): () => void {
  const running = new Map<HTMLDetailsElement, DisclosureRun>();
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");

  const click = (event: MouseEvent) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      !(event.target instanceof Element)
    )
      return;
    const summary = event.target.closest("summary");
    const details = summary?.parentElement;
    if (
      !summary ||
      !(details instanceof window.HTMLDetailsElement) ||
      details.firstElementChild !== summary ||
      details.closest("[inert]")
    )
      return;
    if (event.target.closest("a, button, input, select, textarea")) return;
    const previous = running.get(details);
    const open = !(previous?.open ?? details.open);
    if (
      !previous &&
      (event.detail === 0 || instantFeedback() || !details.animate)
    )
      return;
    event.preventDefault();

    // Read the current animated height before cancelling, so a reversal continues where it is.
    const from = details.getBoundingClientRect().height;
    previous?.finish();
    if (event.detail === 0 || instantFeedback() || !details.animate) {
      details.open = open;
      return;
    }
    details.open = open;
    const to = details.getBoundingClientRect().height;
    details.open = true;
    summary.setAttribute("aria-expanded", String(open));
    details.setAttribute("data-disclosure-moving", "");
    details.toggleAttribute("data-disclosure-closing", !open);
    const content = Array.from(details.children).filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && child !== summary,
    );
    const inertBefore = content.map((child) => child.hasAttribute("inert"));
    if (!open) content.forEach((child) => child.setAttribute("inert", ""));
    // Height is deliberate here: a disclosure must move following content, without scaling its text.
    const animation = details.animate(
      [{ height: `${from}px` }, { height: `${to}px` }],
      {
        duration: open ? T2 : 160,
        easing: EASE_OUT,
      },
    );
    const finish = () => {
      animation.onfinish = null;
      animation.cancel();
      details.open = open;
      summary.removeAttribute("aria-expanded");
      details.removeAttribute("data-disclosure-moving");
      details.removeAttribute("data-disclosure-closing");
      content.forEach((child, index) =>
        child.toggleAttribute("inert", inertBefore[index]!),
      );
      running.delete(details);
    };
    animation.onfinish = finish;
    running.set(details, { open, animation, finish });
  };
  const finishAll = () => {
    for (const run of running.values()) run.finish();
  };
  const keydown = () => finishAll();
  const reduce = () => {
    if (media.matches) finishAll();
  };
  root.addEventListener("click", click);
  root.addEventListener("keydown", keydown);
  media.addEventListener("change", reduce);
  return () => {
    root.removeEventListener("click", click);
    root.removeEventListener("keydown", keydown);
    media.removeEventListener("change", reduce);
    finishAll();
  };
}
