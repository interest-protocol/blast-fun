import type { ReactNode } from "react";

/**
 * The profile's line icons from the prototype's `I` table (24px grid, stroke
 * 1.8, `currentColor`, decorative). The shell's set is `blast-ui/Icons.tsx`.
 */
function LineIcon({ children, className, strokeWidth = "1.8" }: Readonly<{ children: ReactNode; className?: string; strokeWidth?: string }>) {
  return (
    <svg aria-hidden="true" className={className} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={strokeWidth} viewBox="0 0 24 24">
      {children}
    </svg>
  );
}

type IconProps = Readonly<{ className?: string }>;

export const ChevIcon = (p: IconProps) => <LineIcon {...p}><path d="m9 6 6 6-6 6" /></LineIcon>;
export const LockIcon = (p: IconProps) => (
  <LineIcon {...p}><rect height="9" rx="2.5" width="14" x="5" y="11" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></LineIcon>
);
export const GlobeIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5c2.4 2.3 3.5 5.2 3.5 8.5s-1.1 6.2-3.5 8.5c-2.4-2.3-3.5-5.2-3.5-8.5s1.1-6.2 3.5-8.5z" />
  </LineIcon>
);
/** The gate's `I.upload`: the edit sheet's badge on the avatar ("Change picture", OA-44). */
export const UploadIcon = (p: IconProps) => (
  <LineIcon {...p}><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5" /><path d="M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" /></LineIcon>
);
