"use client";

import { instantFeedback } from "#web/components/blast-ui/feedback-motion.ts";
import { EASE_OUT } from "#web/components/blast-ui/motion-tokens.ts";

import { useEffect, type RefObject } from "react";

export const TABLE_PAGE_MOTION_EVENT = "blast:table-page-motion";
export const TABLE_PAGE_SETTLED_EVENT = "blast:table-page-settled";
const TIMING = { duration: 180, easing: EASE_OUT };
type Box = { top: number; height: number };

/** FLIP the footer, card surface and following tables. Text never scales; layout runs once. */
export function useTablePageMotion(root: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const host = root.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const animations = new Map<Element, Animation>();
    let before: Map<HTMLElement, Box> | null = null;
    let section: HTMLElement | null = null;
    let settleFrame: number | null = null;
    const measure = () => {
      const boxes = new Map<HTMLElement, Box>();
      const top = host.getBoundingClientRect().top;
      for (const table of host.querySelectorAll<HTMLElement>(":scope > [data-section]")) {
        const rect = table.getBoundingClientRect();
        boxes.set(table, { top: rect.top - top, height: rect.height });
        for (const element of table.querySelectorAll<HTMLElement>("[data-table-end], [data-table-surface]")) {
          const box = element.getBoundingClientRect();
          boxes.set(element, { top: box.top - rect.top, height: box.height });
        }
        // Coins has an end wrapper containing both the footer and market refresh.
        for (const footer of table.querySelectorAll<HTMLElement>("[data-table-footer]")) {
          if (!footer.closest("[data-table-end]")) {
            const box = footer.getBoundingClientRect();
            boxes.set(footer, { top: box.top - rect.top, height: box.height });
          }
        }
      }
      return boxes;
    };
    const cancel = () => {
      for (const animation of animations.values()) animation.cancel();
      animations.clear();
    };
    const discard = () => {
      before = null;
      section = null;
      if (settleFrame !== null) window.cancelAnimationFrame(settleFrame);
      settleFrame = null;
    };
    const reset = () => { discard(); cancel(); };
    const settled = (event: Event) => {
      if (!before || !section?.contains(event.target as Node)) return;
      if (settleFrame !== null) window.cancelAnimationFrame(settleFrame);
      // Let ResizeObserver consume the committed layout before dropping a same-size page's snapshot.
      settleFrame = window.requestAnimationFrame(() => {
        settleFrame = window.requestAnimationFrame(discard);
      });
    };
    const start = (event: Event) => {
      const pointer = event instanceof CustomEvent && event.detail === true;
      if (!pointer || instantFeedback()) { reset(); return; }
      discard();
      before = measure(); // Includes the current visual position when interrupted.
      section = (event.target as HTMLElement).closest<HTMLElement>("[data-section]");
      cancel();
    };
    const animate = (element: HTMLElement, frames: Keyframe[]) => {
      const animation = element.animate(frames, TIMING);
      animations.set(element, animation);
      animation.onfinish = () => { if (animations.get(element) === animation) animations.delete(element); };
    };
    const observer = new ResizeObserver(() => {
      if (!before || !section || instantFeedback()) return;
      const after = measure();
      const previous = before.get(section);
      const next = after.get(section);
      if (!previous || !next || Math.abs(previous.height - next.height) < 1) return;
      cancel();
      for (const [element, box] of after) {
        const old = before.get(element);
        if (!old) continue;
        if (element.hasAttribute("data-table-surface")) {
          if (box.height && Math.abs(old.height - box.height) > 1) animate(element, [{ transform: `scaleY(${old.height / box.height})` }, { transform: "scaleY(1)" }]);
        } else if (Math.abs(old.top - box.top) > 1) {
          animate(element, [{ transform: `translateY(${old.top - box.top}px)` }, { transform: "translateY(0)" }]);
        }
      }
      const list = section.querySelector<HTMLElement>("ol");
      if (list) animate(list, [{ opacity: .65 }, { opacity: 1 }]);
      discard();
    });
    observer.observe(host);
    host.addEventListener(TABLE_PAGE_MOTION_EVENT, start);
    host.addEventListener(TABLE_PAGE_SETTLED_EVENT, settled);
    window.addEventListener("resize", reset);
    reduce.addEventListener("change", reset);
    return () => { reset(); observer.disconnect(); host.removeEventListener(TABLE_PAGE_MOTION_EVENT, start); host.removeEventListener(TABLE_PAGE_SETTLED_EVENT, settled); window.removeEventListener("resize", reset); reduce.removeEventListener("change", reset); };
  }, [root]);
}
