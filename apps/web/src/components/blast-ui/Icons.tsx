import type { ReactNode } from "react";

import brandPaths from "@blast/core/modules/mission-control/card-renderer/brand-paths.json" with { type: "json" };

/**
 * The canonical UI's icons: 24px line icons, stroke 1.8, drawn in
 * `currentColor`, decorative (`aria-hidden`). The geometry is the approved
 * boards' (2026-10-27): the rail glyphs from the Rail board, the bell from the
 * Topbar board, the chevrons, search and check from the System board, the rest
 * from the page boards that draw them. Sizes come from the CSS of the control
 * that holds them.
 */
function LineIcon({ children, className, strokeWidth = "1.8" }: Readonly<{ children: ReactNode; className?: string; strokeWidth?: string }>) {
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

/** Official wallet marks; the visible wallet name supplies the accessible label. */
export const SlushLogo = (p: IconProps) => (
  // eslint-disable-next-line @next/next/no-img-element
  <img alt="" aria-hidden="true" className={p.className} draggable={false} height={24} src="/blast-ui/wallets/slush.svg" width={24} />
);
export const NightlyLogo = (p: IconProps) => (
  // eslint-disable-next-line @next/next/no-img-element
  <img alt="" aria-hidden="true" className={p.className} draggable={false} height={24} src="/blast-ui/wallets/nightly.png" width={24} />
);
export const ScallopLogo = (p: IconProps) => (
  // eslint-disable-next-line @next/next/no-img-element
  <img alt="" aria-hidden="true" className={p.className} draggable={false} height={24} src="/blast-ui/wallets/scallop.png" width={24} />
);

export const MahaloLogo = (p: IconProps) => (
  // eslint-disable-next-line @next/next/no-img-element
  <img alt="" aria-hidden="true" className={p.className} draggable={false} height={24} src="/blast-ui/wallets/mahalo.png" width={24} />
);

export const HomeIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />
  </LineIcon>
);
/** "Presales" (Rail board): a ticket with its stub and two perforations. */
export const TicketIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <path d="M5 6h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zM8 6v12M16 10h1M16 14h1" />
  </LineIcon>
);
/** "Bonding": a bonding curve over its axes (the design's `I.curve`). */
export const CurveIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <path d="M4 20c7 0 10.5-3.5 12.5-8S19 5 20 4" />
    <path d="M4 4v16h16" />
  </LineIcon>
);
export const TrophyIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <path d="M8 4h8v6a4 4 0 0 1-8 0V4ZM8 6H4v2a4 4 0 0 0 4 4m8-6h4v2a4 4 0 0 1-4 4m-4 2v4m-4 2h8m-7-2h6" />
  </LineIcon>
);
export const ChartLineIcon = (p: IconProps) => (
  <LineIcon {...p}><path d="M3 19h18M4 14l5-5 4 3 6-7" /></LineIcon>
);

export const ChartCandlesIcon = (p: IconProps) => (
  <LineIcon {...p}><path d="M6 3v3m0 8v4m6-13v5m0 7v4m6-18v3m0 7v5" /><rect x="4" y="6" width="4" height="8" /><rect x="10" y="10" width="4" height="7" /><rect x="16" y="6" width="4" height="7" /></LineIcon>
);

export const FilterIcon = (p: IconProps) => (
  <LineIcon {...p}><path d="M4 6h16M7 12h10M10 18h4" /></LineIcon>
);

export const SearchIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </LineIcon>
);
export const SwapIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <path d="M4 8h14l-4-4M20 16H6l4 4" />
  </LineIcon>
);
export const BellIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0" />
  </LineIcon>
);
export const UserIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4.5 20c1-3.8 4.3-5.8 7.5-5.8s6.5 2 7.5 5.8" />
  </LineIcon>
);
export const GearIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
    <circle cx="16" cy="7" r="2.2" />
    <circle cx="10" cy="17" r="2.2" />
  </LineIcon>
);

export const PencilIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <path d="m16 4 4 4M4 20l4.5-1L20 7.5a2.8 2.8 0 0 0-4-4L4.5 15z" />
  </LineIcon>
);

export const UserPlusIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <circle cx="9" cy="8" r="4" />
    <path d="M2 20c1-3.8 4-5.8 7-5.8 1.5 0 3 .5 4.2 1.4M18 12v8M14 16h8" />
  </LineIcon>
);
/** "pie": Portfolio (OA-41, the layer's `I.pie`). */
export const PieIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <path d="M20.5 13.5A8.5 8.5 0 1 1 10.5 3.5v10z" />
    <path d="M14 3.2a8.5 8.5 0 0 1 6.8 6.8H14z" />
  </LineIcon>
);
/** "chev": a row that goes somewhere (the account menu's profile row, OA-41). */
export const ChevronIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <path d="m9 6 6 6-6 6" />
  </LineIcon>
);
/** "previous" and "next": a pager's steps (not disclosure; DisclosureButton owns the disclosure chevron). */
export const PreviousIcon = (p: IconProps & Readonly<{ strokeWidth?: "2" | "2.2" }>) => (
  <LineIcon {...p}>
    <path d="m15 6-6 6 6 6" />
  </LineIcon>
);
export const NextIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <path d="m9 6 6 6-6 6" />
  </LineIcon>
);
/** "panel-left": the rail's collapse toggle. */
export const PanelLeftIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <rect height="16" rx="3" width="18" x="3" y="4" />
    <path d="M9 4v16" />
  </LineIcon>
);
/** "panel-right": the right column's collapse toggle. */
export const PanelRightIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <rect height="16" rx="3" width="18" x="3" y="4" />
    <path d="M15 4v16" />
  </LineIcon>
);
export const EyeIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </LineIcon>
);
export const EyeOffIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <path d="M3 3l18 18" />
    <path d="M10.6 5.6A9.7 9.7 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-3.1 3.9M6.6 6.6A17.6 17.6 0 0 0 2 12s3.6 6.5 10 6.5a9.4 9.4 0 0 0 4.2-1" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  </LineIcon>
);
export const PlusIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <path d="M12 5v14M5 12h14" />
  </LineIcon>
);
/** "More" (Rail board): three filled dots. */
export const DotsIcon = (p: IconProps) => (
  <svg aria-hidden="true" className={p.className} fill="currentColor" viewBox="0 0 24 24">
    <circle cx="5" cy="12" r="1.6" />
    <circle cx="12" cy="12" r="1.6" />
    <circle cx="19" cy="12" r="1.6" />
  </svg>
);
export const SunIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
  </LineIcon>
);
export const MoonIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
  </LineIcon>
);
export const LogOutIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10" />
  </LineIcon>
);
export const CheckIcon = ({ strong = false, ...props }: IconProps & { strong?: boolean }) => (
  <LineIcon {...props} strokeWidth={strong ? "2.6" : undefined}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </LineIcon>
);
export const AlertCircleIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5v5" />
    <circle cx="12" cy="16.5" r=".8" fill="currentColor" stroke="none" />
  </LineIcon>
);
export const InfoIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </LineIcon>
);
export const CloseIcon = (p: IconProps & Readonly<{ strokeWidth?: "2" | "2.2" }>) => (
  <LineIcon {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </LineIcon>
);
export const ExternalIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <path d="M7 17 17 7M9 7h8v8" />
  </LineIcon>
);
/** "Copy" (Sale and Blast mode boards): two stacked sheets. */
export const CopyIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <rect height="12" rx="3" width="12" x="8" y="8" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </LineIcon>
);
/** "Deposit" (Portfolio and Settings boards): an arrow down. */
export const ArrowDownIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <path d="M12 5v14M6 13l6 6 6-6" />
  </LineIcon>
);
/** "Withdraw" (Portfolio and Settings boards): an arrow up. */
export const ArrowUpIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </LineIcon>
);
/** "Flip" (Swap and Coin boards): the two directions of a trade, swapped. */
export const FlipIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <path d="M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3" />
  </LineIcon>
);

export const GridIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <rect height="7" rx="1.5" width="7" x="4" y="4" />
    <rect height="7" rx="1.5" width="7" x="13" y="4" />
    <rect height="7" rx="1.5" width="7" x="4" y="13" />
    <rect height="7" rx="1.5" width="7" x="13" y="13" />
  </LineIcon>
);
/** Telegram's paper plane, as a line glyph (the rail's links row, the sale page's project links). */
export const TelegramIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <path d="m21 4-3.2 15.4c-.2 1-.8 1.2-1.7.8l-4.6-3.4-2.2 2.1c-.3.3-.5.5-1 .5l.3-4.7 8.6-7.8c.4-.3-.1-.5-.6-.2L5.9 13.4 1.3 12c-1-.3-1-1 .2-1.5L19.8 3.4c.8-.3 1.6.2 1.2.6z" />
  </LineIcon>
);
/** "How Blast works" (map.blast.fun): a folded map. */
export const MapIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <path d="M9 4 3 6.5V20l6-2.5 6 2.5 6-2.5V4l-6 2.5z" />
    <path d="M9 4v13.5M15 6.5V20" />
  </LineIcon>
);
/** Docs (docs.blast.fun): an open book. */
export const BookIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <path d="M2.5 5H8a4 4 0 0 1 4 4v11a3 3 0 0 0-3-3H2.5z" />
    <path d="M21.5 5H16a4 4 0 0 0-4 4v11a3 3 0 0 1 3-3h6.5z" />
  </LineIcon>
);

const HELMET_VIEW_BOX = "408.5 396.5 436.5 289.5";

/** The Blast helmet (fill `#FF4C98`), from the card renderer's brand paths. */
export function HelmetMark({ className }: IconProps) {
  return (
    <svg aria-hidden="true" className={className} viewBox={HELMET_VIEW_BOX}>
      <path d={brandPaths.helmet} fill="#FF4C98" fillRule="evenodd" />
    </svg>
  );
}

/** The verified rosette next to a name (OA-8: the account has X linked). */
export function VerifiedBadge({ className }: IconProps) {
  return (
    <svg aria-label="Verified" className={className} role="img" viewBox="0 0 24 24">
      <path
        d="M12 1.8l2.6 1.9 3.2-.2 1 3.1 2.6 1.9-1 3.1 1 3.1-2.6 1.9-1 3.1-3.2-.2L12 22.2l-2.6-1.9-3.2.2-1-3.1-2.6-1.9 1-3.1-1-3.1 2.6-1.9 1-3.1 3.2.2z"
        className="verifiedSeal"
        fill="currentColor"
      />
      <path d="m8.2 12.2 2.5 2.5 5.1-5.2" className="verifiedCheck" fill="none" stroke="#fff" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" />
    </svg>
  );
}

export const COIN_VERIFIED_LABEL = "Known deployer";

/** The pink helmet sits after a coin's ticker or name when Blast checked who is behind it. */
export function CoinVerifiedMark({ size = "md", decorative = false, community = false }: Readonly<{ size?: "sm" | "md" | "lg"; decorative?: boolean; community?: boolean }>) {
  const label = community ? "Verified community" : COIN_VERIFIED_LABEL;
  return (
    <svg
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : label}
      className={`coinVerified ${size}`}
      role={decorative ? undefined : "img"}
      viewBox={HELMET_VIEW_BOX}
    >
      {decorative ? null : <title>{label}</title>}
      <path d={brandPaths.helmet} fillRule="evenodd" />
    </svg>
  );
}

export function CoinLegacyMark() {
  return (
    <span aria-label="Legacy · Blast V1" className="coinLegacy" role="img" title="Legacy · Blast V1">
      <span aria-hidden="true">V1</span>
    </span>
  );
}

export const PeopleIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3 19c.6-3.2 3-5 6-5s5.4 1.8 6 5" />
    <path d="M16 5.2a3 3 0 0 1 0 5.6M18 14.3c1.6.7 2.6 2.3 3 4.7" />
  </LineIcon>
);

/** The X logo, filled in `currentColor`. */
export function XLogo({ className }: IconProps) {
  return (
    <svg aria-hidden="true" className={className} fill="currentColor" viewBox="0 0 24 24">
      <path d="M17.8 3h3.1l-6.8 7.7L22 21h-6.2l-4.9-6.3L5.3 21H2.2l7.2-8.3L1.8 3h6.4l4.4 5.8zm-1.1 16.2h1.7L7.4 4.7H5.6z" />
    </svg>
  );
}

/** Google's "G" in its four colours. */
export function GoogleLogo({ className }: IconProps) {
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 24 24">
      <path d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3z" fill="#4285F4" />
      <path d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z" fill="#34A853" />
      <path d="M6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.4H3.1A10 10 0 0 0 2 12c0 1.6.4 3.1 1.1 4.6z" fill="#FBBC05" />
      <path d="M12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 3.1 7.4L6.4 10c.8-2.3 3-4 5.6-4z" fill="#EA4335" />
    </svg>
  );
}

export const WalletIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <rect height="13" rx="3" width="18" x="3" y="6" />
    <path d="M16 12.5h2M3 9.5h15a3 3 0 0 1 3 3" />
  </LineIcon>
);

/** Six-point handle for direct panel manipulation. */
export const GripIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <path d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01" strokeWidth="3" />
  </LineIcon>
);
