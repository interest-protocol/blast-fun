import type { SaleCoverSource } from "@blast/core/modules/social/contracts/sales.ts";

/** A cover as stored: its key in the public store, URL and size, and its upload's size (null when never measured). */
export type StoredCover = Readonly<{ key: string; url: string; width: number; height: number; source: SaleCoverSource | null }>;
