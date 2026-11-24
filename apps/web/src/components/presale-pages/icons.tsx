import type { ReactNode } from "react";

/** The design's line icons the presale pages use (24px grid, stroke 1.8, `currentColor`, decorative). */
function Line({ children, width = 1.8, className }: Readonly<{ children: ReactNode; width?: number; className?: string }>) {
  return (
    <svg aria-hidden="true" className={className} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={width} viewBox="0 0 24 24">
      {children}
    </svg>
  );
}

type P = Readonly<{ className?: string }>;
export const ChevIcon = (p: P) => <Line {...p}><path d="m9 6 6 6-6 6" /></Line>;
/** The list view: three lines. */
export const RowsIcon = (p: P) => <Line {...p}><path d="M4 7h16M4 12h16M4 17h16" /></Line>;
export const StarIcon = (p: P) => <Line {...p}><path d="m12 4 2.4 5 5.4.6-4 3.7 1.1 5.3L12 16l-4.9 2.6 1.1-5.3-4-3.7 5.4-.6z" /></Line>;
export const BellIcon = (p: P) => (
  <Line {...p}>
    <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
    <path d="M10 20a2 2 0 0 0 4 0" />
  </Line>
);
export const LockIcon = (p: P) => (
  <Line {...p}>
    <rect height="9" rx="2.5" width="14" x="5" y="11" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Line>
);
/** The whitelist marks of an upcoming sale's Blast box: on it, not on it, open to everyone, can't check. */
export const TickIcon = (p: P) => <Line {...p} width={2.6}><path d="M5 12.5l4.5 4.5L19 7.5" /></Line>;
export const DashIcon = (p: P) => <Line {...p} width={2.6}><path d="M6 12h12" /></Line>;
export const PeopleIcon = (p: P) => (
  <Line {...p} width={2}>
    <circle cx="9" cy="9" r="3.2" />
    <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
    <circle cx="17" cy="9.5" r="2.6" />
    <path d="M15.5 14.2A4.6 4.6 0 0 1 21 19" />
  </Line>
);
export const InfoIcon = (p: P) => (
  <Line {...p} width={2}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5v5.5M12 16.4v.1" />
  </Line>
);
/** The trust badges' marks (R3-23): the gate's `I.shield` and `I.doc`. */
export const ShieldIcon = (p: P) => (
  <Line {...p}>
    <path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z" />
    <path d="m9 12 2 2 4-4" />
  </Line>
);
export const DocIcon = (p: P) => (
  <Line {...p}>
    <path d="M7 3h7l5 5v13H7z" />
    <path d="M14 3v5h5M10 13h6M10 17h6" />
  </Line>
);
export const RocketIcon = (p: P) => (
  <Line {...p}>
    <path d="M14.5 4.5c2.5-1 4.5-1 5-.5s.5 2.5-.5 5L13 15.5 8.5 11z" />
    <path d="M5 15c-1.5 1.2-2 4-2 4s2.8-.5 4-2" />
    <path d="M8.5 11 6 10.5 8 8h3.5M13 15.5l.5 2.5L16 16v-3.5" />
  </Line>
);
export function XMark({ className }: P) {
  return (
    <svg aria-hidden="true" className={className} fill="currentColor" viewBox="0 0 24 24">
      <path d="M17.8 3h3.1l-6.8 7.7L22 21h-6.2l-4.9-6.3L5.3 21H2.2l7.2-8.3L1.8 3h6.4l4.4 5.8zm-1.1 16.2h1.7L7.4 4.7H5.6z" />
    </svg>
  );
}
/* R3-28: the sale's links and its cover (the gate's `I.link`, `I.tg`, `I.image`, `I.upload`; `I.doc` and `I.shield` are R3-23's above). */
export const LinkIcon = (p: P) => <Line {...p}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></Line>;
export { TelegramIcon } from "#web/components/blast-ui/Icons.tsx";
export const ImageIcon = (p: P) => (
  <Line {...p}>
    <rect height="16" rx="4" width="16" x="4" y="4" />
    <circle cx="9.5" cy="9.5" r="1.6" />
    <path d="m20 15-4.5-4.5L6 20" />
  </Line>
);
/** The boards' share glyph: an arrow out of a tray. */
export const UploadIcon = (p: P) => (
  <Line {...p}>
    <path d="M12 15V4M7.5 8.5 12 4l4.5 4.5" />
    <path d="M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" />
  </Line>
);
