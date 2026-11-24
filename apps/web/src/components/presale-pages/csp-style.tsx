"use client";

import { useLayoutEffect } from "react";

/** Applies every server-rendered `data-csp-style` once, after hydration. Mount it once per page tree. */
export function CspStyles() {
  useLayoutEffect(() => {
    for (const element of document.querySelectorAll<HTMLElement | SVGElement>("[data-csp-style]")) {
      const text = element.getAttribute("data-csp-style") ?? "";
      if (element.style.cssText !== text) element.style.cssText = text;
    }
  }, []);
  return null;
}
