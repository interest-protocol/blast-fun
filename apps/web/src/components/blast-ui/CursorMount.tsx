"use client";

import { useLayoutEffect } from "react";

export function CursorMount() {
  useLayoutEffect(() => {
    const root = document.querySelector<HTMLElement>("[data-blast-ui]");
    if (!root || !window.matchMedia("(hover: hover) and (pointer: fine) and (forced-colors: none)").matches) return;

    let active = true;
    let frame = 0;
    const restore = () => {
      active = false;
      root.removeAttribute("data-cursor-mounting");
      window.clearTimeout(timeout);
      window.cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", restore);
      window.removeEventListener("pointerdown", restore);
      window.removeEventListener("blur", restore);
    };
    const timeout = window.setTimeout(restore, 700);
    root.setAttribute("data-cursor-mounting", "");
    window.addEventListener("pointermove", restore, { passive: true });
    window.addEventListener("pointerdown", restore, { passive: true });
    window.addEventListener("blur", restore);

    const arrows = ["arrow.svg", "arrow-dark.svg"].map(async (name) => {
      const image = new window.Image();
      image.src = `/blast-ui/cursors/${name}`;
      await image.decode();
    });
    void Promise.allSettled(arrows).then(() => {
      if (!active) return;
      // Give the hidden cursor a painted frame even when the images are cached.
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(restore);
      });
    });

    // shortcut: CSS toggling may not repaint a stationary OS cursor; verify on macOS Chrome.
    return restore;
  }, []);

  return null;
}
