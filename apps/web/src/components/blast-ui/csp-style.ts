import type { CSSProperties } from "react";

/**
 * Per-element styles (a bar's width, a split's share, a mark's colours)
 * under the site's CSP: `style-src` allows no inline style attributes, so the
 * server-rendered `style` is dropped by the browser. `dyn(style)` adds the
 * same declarations as `data-csp-style`, and `<CspStyles />` writes them
 * through the CSSOM (which the policy allows) once the page hydrates; after
 * that React updates styles through the CSSOM itself. Until then the CSS
 * gives each element a neutral default (an empty bar, a plain banner).
 */
const UNITLESS = new Set(["flex", "opacity", "zIndex", "fontWeight", "lineHeight"]);

function cssText(style: CSSProperties): string {
  return Object.entries(style)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => {
      const name = key.startsWith("--") ? key : key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
      const text = typeof value === "number" && !UNITLESS.has(key) && !key.startsWith("--") ? `${value}px` : String(value);
      return `${name}: ${text}`;
    })
    .join("; ");
}

export function dyn(style: CSSProperties): Readonly<{ style: CSSProperties; "data-csp-style": string }> {
  return { style, "data-csp-style": cssText(style) };
}
