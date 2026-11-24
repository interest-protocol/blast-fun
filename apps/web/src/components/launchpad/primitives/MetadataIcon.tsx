"use client";

import { useState } from "react";

import { IdentityGradient } from "#web/components/blast-ui/IdentityGradient.tsx";
import { validMetadataIconUrl } from "./metadata-icon";
import styles from "./primitives.module.css";

/**
 * A coin's metadata icon. Valid creator images render as given; missing,
 * invalid, or broken ones become a colorful gradient derived from
 * `identity` (the coin type), never an official Sui or Blast mark. The icon
 * is decorative unless `label` names it.
 */
export function MetadataIcon({
  src,
  identity,
  label,
  size = 32,
}: Readonly<{ src: string | null | undefined; identity: string; label?: string; size?: 24 | 32 | 40 }>) {
  const url = validMetadataIconUrl(src);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  if (url && failedUrl !== url) {
    return (
      // Creator icons live on arbitrary hosts, so Next's image optimizer does not apply.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        ref={(image) => {
          // An image that failed before hydration never fires onError.
          if (image?.complete && image.naturalWidth === 0) setFailedUrl(url);
        }}
        className={styles.icon}
        data-size={size}
        src={url}
        alt={label ?? ""}
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailedUrl(url)}
      />
    );
  }

  const named = label ? { role: "img", "aria-label": label } : { "aria-hidden": true };
  return (
    <svg
      className={styles.icon}
      data-size={size}
      data-fallback="generated"
      viewBox="0 0 1 1"
      width={size}
      height={size}
      {...named}
    >
      <IdentityGradient identity={identity} />
    </svg>
  );
}
