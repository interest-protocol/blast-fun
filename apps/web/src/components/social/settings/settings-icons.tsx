import type { ReactNode } from "react";

/**
 * The settings page's icons and wallet marks, drawn as the prototype draws
 * them (its `I` table and `markSVG`): 24px line icons with a 1.8 stroke in
 * `currentColor`, decorative.
 */
function Line({ children, className, strokeWidth = "1.8" }: Readonly<{ children: ReactNode; className?: string; strokeWidth?: string }>) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={strokeWidth}
      viewBox="0 0 24 24"
    >
      {children}
    </svg>
  );
}

type IconProps = Readonly<{ className?: string }>;

export const WalletIcon = (p: IconProps) => (
  <Line {...p}>
    <rect height="13" rx="3" width="18" x="3" y="6" />
    <path d="M16 12.5h2M3 9.5h15a3 3 0 0 1 3 3" />
  </Line>
);

export const AddIcon = (p: IconProps) => (
  <Line {...p}>
    <path d="M12 5v14M5 12h14" />
  </Line>
);

export const ChevronIcon = (p: IconProps) => (
  <Line {...p}>
    <path d="m9 6 6 6-6 6" />
  </Line>
);

export const DismissIcon = (p: IconProps) => (
  <Line {...p} strokeWidth="2.2">
    <path d="M6 6l12 12M18 6 6 18" />
  </Line>
);

/** The Sui and USDC coin marks the wallet card draws. */
export const SUI_LOGO_SRC = "/blast-ui/coins/sui.svg";
export const USDC_LOGO_SRC = "/blast-ui/coins/usdc.svg";
