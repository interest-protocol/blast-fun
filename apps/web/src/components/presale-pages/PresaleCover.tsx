"use client";

import { useState } from "react";
import type { SocialSaleMetadata } from "@blast/core/web/contracts/sales.ts";
import { coverPalette } from "./cover-palette";
import styles from "./PresaleCover.module.css";

export function PresaleCover({ cover, presaleId, className, eager = false }: Readonly<{
  cover?: SocialSaleMetadata["cover"];
  presaleId?: string | null;
  className?: string;
  /** Above the fold (a sale page's head): load at once. */
  eager?: boolean;
}>) {
  const [failed, setFailed] = useState<string | null>(null);
  const shown = cover && /^(https:|data:image\/)/.test(cover.url) && failed !== cover.url;
  return <span aria-hidden="true" className={`${styles.cover} ${className ?? ""}`} data-cover-palette={coverPalette(presaleId)}>
    {shown ? (
      // eslint-disable-next-line @next/next/no-img-element -- creator uploads can use any public asset host
      <img alt="" decoding="async" fetchPriority={eager ? "high" : undefined} height={cover.height} loading={eager ? "eager" : "lazy"} onError={() => setFailed(cover.url)} ref={(image) => {
        if (image?.complete && image.naturalWidth === 0) setFailed(cover.url);
      }} referrerPolicy="no-referrer" src={cover.url} width={cover.width} />
    ) : null}
  </span>;
}
