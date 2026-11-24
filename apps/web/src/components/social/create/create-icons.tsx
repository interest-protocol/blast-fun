import type { ReactNode } from "react";

/** The design's line icons the Create page draws (24px grid, 1.8 stroke unless the design says otherwise), decorative. */
function Icon({ children, width = "1.8" }: Readonly<{ children: ReactNode; width?: string }>) {
  return (
    <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={width} viewBox="0 0 24 24">
      {children}
    </svg>
  );
}

/** A finished step in the step bar, and a met condition (2.2 stroke, the boards' check). */
export const DoneIcon = () => (
  <Icon width="2.2">
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Icon>
);
export const CheckIcon = () => (
  <Icon width="2.6">
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Icon>
);
export const LockIcon = () => (
  <Icon width="2">
    <rect height="10" rx="2" width="14" x="5" y="11" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Icon>
);
export const ImageIcon = () => (
  <Icon>
    <rect height="16" rx="4" width="16" x="4" y="4" />
    <circle cx="9.5" cy="9.5" r="1.6" />
    <path d="m20 15-4.5-4.5L6 20" />
  </Icon>
);
export const UploadIcon = () => (
  <Icon width="2">
    <path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M5 20h14" />
  </Icon>
);
/** The design's `I.clock`: publishing opens later (the review's "not available yet" line). */
export const ClockIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Icon>
);
