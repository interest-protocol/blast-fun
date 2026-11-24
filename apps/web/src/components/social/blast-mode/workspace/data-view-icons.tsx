import type { DataView } from "@blast/core/modules/social/blast-workspace/setup.ts";

/** One line path per Data view, on a 24px grid; the rail tabs and Customize share them. */
const DATA_VIEW_PATHS: Readonly<Record<DataView, string>> = {
  Coins:
    "M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6",
  Traders: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c1-4 4-6 8-6s7 2 8 6",
  Presales:
    "M3 8a2 2 0 0 0 0 4v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4a2 2 0 0 1 0-4V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2zM14 4v16",
  Activity: "M3 12h4l3-8 4 16 3-8h4",
  Bonding: "M3 20h18M4 17c5 0 8-2.5 10-6.5S17.5 4 20 4",
  Portfolio: "M12 3v9h9A9 9 0 1 1 12 3zM15 3.5A9 9 0 0 1 20.5 9H15z",
  Feed: "M21 11a8 8 0 0 1-8 8H7l-5 3 2-6a8 8 0 1 1 17-5M8 9h8M8 13h5",
};

/** Decorative view icon in `currentColor`; the visible view name supplies the label. Size comes from CSS. */
export function DataViewIcon({ view, className }: Readonly<{ view: DataView; className?: string }>) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      data-view-icon={view}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
      viewBox="0 0 24 24"
    >
      <path d={DATA_VIEW_PATHS[view]} />
    </svg>
  );
}
