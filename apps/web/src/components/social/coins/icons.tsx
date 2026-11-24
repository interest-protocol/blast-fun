import type { ReactNode } from "react";

export { SwapIcon } from "../../blast-ui/Icons";

/**
 * The coins sheet's line icons from the prototype's `I` table that no other
 * section draws yet (24px, `currentColor`, decorative): the deposit checks
 * (stroke 2.6) and the favourite star. The others come from the
 * profile's and the settings' sets.
 *
 * The star lives here, with the only screens that draw it. In the reference
 * `allCoinsList()` renders `I.star`, which is defined in the Blast-mode
 * bundle (FEATURE-MAP-R3 §22.1 item 18: "a non-Blast build renders an empty
 * pin button"); nothing in the coins surface may depend on Blast mode.
 */
function Line({ children, strokeWidth = "1.8" }: Readonly<{ children: ReactNode; strokeWidth?: string }>) {
  return (
    <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={strokeWidth} viewBox="0 0 24 24">
      {children}
    </svg>
  );
}

export const KnowCheckIcon = () => (
  <Line strokeWidth="2.6">
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Line>
);

export const StarIcon = () => (
  <Line>
    <path d="m12 4 2.4 5 5.4.6-4 3.7 1.1 5.3L12 16l-4.9 2.6 1.1-5.3-4-3.7 5.4-.6z" />
  </Line>
);

/** R3-33's swap (the gate's `I.flip`, `I.gas`, `I.chevDown`, `I.search`). */
export const FlipIcon = () => (
  <Line>
    <path d="M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3" />
  </Line>
);

export const GasIcon = () => (
  <Line>
    <path d="M5 20V6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v14M4 20h12M8 9h4" />
    <path d="M15 10h1.5a1.5 1.5 0 0 1 1.5 1.5V17a1.5 1.5 0 0 0 3 0V8.5L18 6" />
  </Line>
);

export const SearchIcon = () => (
  <Line>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </Line>
);
