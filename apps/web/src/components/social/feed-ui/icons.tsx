import type { ReactNode } from "react";

/**
 * The post card's and home feed's own icons (the prototype's `I` table): 24px
 * line icons, stroke 1.8 unless noted, in `currentColor`, decorative
 * (`aria-hidden`). Sizes come from the CSS of the control that holds them.
 * The shared ones (dots, external, grid, helmet, verified) are the shell's,
 * re-exported here so the feed imports its icons from one place.
 */
export { DotsIcon, ExternalIcon, GridIcon, HelmetMark, VerifiedBadge } from "#web/components/blast-ui/Icons.tsx";
type IconProps = Readonly<{ className?: string }>;

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

/** The rocket reaction (OA-5). Its first path is the body the pressed state fills. */
export const RocketIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <path d="M14.5 4.5c2.5-1 4.5-1 5-.5s.5 2.5-.5 5L13 15.5 8.5 11z" />
    <path d="M5 15c-1.5 1.2-2 4-2 4s2.8-.5 4-2" />
    <path d="M8.5 11 6 10.5 8 8h3.5M13 15.5l.5 2.5L16 16v-3.5" />
  </LineIcon>
);

export const PeopleIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3 19c.6-3.2 3-5 6-5s5.4 1.8 6 5" />
    <path d="M16 5.2a3 3 0 0 1 0 5.6M18 14.3c1.6.7 2.6 2.3 3 4.7" />
  </LineIcon>
);

export const BoltIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <path d="M13 3 5 13.5h6L10 21l8-10.5h-6z" />
  </LineIcon>
);

/** The action chips (`.act`, stroke 2.2): BLAST (ticket, without the nav icon's perforation), CLAIM (download), CALL (target). */
export const ActTicketIcon = (p: IconProps) => (
  <LineIcon {...p} strokeWidth="2.2">
    <path d="M4 7.5A1.5 1.5 0 0 1 5.5 6h13A1.5 1.5 0 0 1 20 7.5V10a2 2 0 0 0 0 4v2.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 16.5V14a2 2 0 0 0 0-4z" />
  </LineIcon>
);

/** oa41's Buy and Sell chips (the prototype's `ACT.buy` / `ACT.sell`): an arrow up or down to the right, at the chips' drawn 1.8 stroke. */
export const BuyIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <path d="M7 17 17 7M9 7h8v8" />
  </LineIcon>
);

export const SellIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <path d="M7 7l10 10M17 9v8H9" />
  </LineIcon>
);

/** oa41's `I.trend`: the "why now" line above a buy. */
export const TrendIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <path d="M3.5 16.5 9 11l4 4 7.5-7.5" />
    <path d="M15 7.5h5.5V13" />
  </LineIcon>
);

export const DownloadIcon = (p: IconProps) => (
  <LineIcon {...p} strokeWidth="2.2">
    <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
  </LineIcon>
);

export const TargetIcon = (p: IconProps) => (
  <LineIcon {...p} strokeWidth="2.2">
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="3.5" />
  </LineIcon>
);
