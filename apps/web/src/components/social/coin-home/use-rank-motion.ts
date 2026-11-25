"use client";

import { instantFeedback } from "#web/components/blast-ui/feedback-motion.ts";
import { EASE_IN_OUT, EASE_OUT } from "#web/components/blast-ui/motion-tokens.ts";

import { useLayoutEffect, useRef } from "react";

type RowPosition = Readonly<{ id: string; top: number }>;

/**
 * Animate rank changes, in layout coordinates so scrolling never looks like a rank change.
 * Rows slide when the same list re-ranks (`view` changes within one `group`, such as a new sort);
 * a new `group` (another source or page) starts without motion.
 */
export function useRankMotion(view: string, group: string = view) {
  const root = useRef<HTMLOListElement>(null);
  const previous = useRef<{ view: string; group: string; rows: RowPosition[] } | null>(null);
  const restoring = useRef(false);
  const animations = useRef(new Map<HTMLElement, Animation>());

  useLayoutEffect(() => {
    const list = root.current;
    if (!list) return;
    const rows = Array.from(list.children).filter((row): row is HTMLElement => row instanceof HTMLElement);
    // Read all layout before writing animations. offsetTop excludes the running transform.
    const positions = rows.map(row => ({ id: row.dataset.listRow ?? "", top: row.offsetTop }));
    const before = previous.current;
    previous.current = { view, group, rows: positions };
    const changed = before && (before.rows.length !== positions.length || positions.some((row, index) => row.id !== before.rows[index]?.id));
    const reduce = instantFeedback();
    const restored = restoring.current;
    restoring.current = false;
    if (!before || before.group !== group || reduce || restored) {
      animations.current.forEach(animation => animation.cancel());
      animations.current.clear();
      return;
    }
    if (!changed) return;
    const oldPositions = new Map(before.rows.map(row => [row.id, row.top]));
    const moves = rows.map((row, index) => {
      const oldTop = oldPositions.get(positions[index]!.id);
      const transform = getComputedStyle(row).transform;
      const offset = !transform || transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m42;
      return { row, delta: oldTop === undefined ? null : oldTop - positions[index]!.top + offset };
    });
    animations.current.forEach(animation => animation.cancel());
    animations.current.clear();
    for (const { row, delta } of moves) {
      if (typeof row.animate !== "function" || delta === 0) continue;
      const animation = row.animate(
        delta === null ? [{ opacity: 0 }, { opacity: 1 }] : [{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }],
        { duration: before.view === view ? 180 : 240, easing: delta === null ? EASE_OUT : EASE_IN_OUT },
      );
      animations.current.set(row, animation);
      animation.onfinish = () => animations.current.delete(row);
    }
  });

  useLayoutEffect(() => {
    const active = animations.current;
    const onRestore = () => { restoring.current = true; };
    window.addEventListener("popstate", onRestore);
    return () => {
      window.removeEventListener("popstate", onRestore);
      active.forEach(animation => animation.cancel());
      active.clear();
    };
  }, []);
  return root;
}
