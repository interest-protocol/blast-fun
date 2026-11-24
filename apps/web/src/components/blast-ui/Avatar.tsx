"use client";

import { useState } from "react";

import { dyn } from "./csp-style";
import { IdentityGradient } from "./IdentityGradient";

import styles from "./Avatar.module.css";
import { avatarImageSources, avatarSource } from "./avatar-source";

export type AvatarProps = Readonly<{ accountId: string; avatarUrl: string | null; size?: number }>;

/**
 * A Blast Account's avatar, `size` CSS pixels wide. An `https` avatar renders
 * as given (an X photo tries its original, then its 400 px size);
 * an account without one (or with an unusable or failing one) gets a generated default:
 * a colorful gradient derived from its account id, so the same
 * account always looks the same. Decorative: the name next to it says who.
 */
export function Avatar({
  accountId,
  avatarUrl,
  size = 32,
  ring,
}: AvatarProps & Readonly<{ ring?: { edition: string; source: string } }>) {
  const url = avatarSource(avatarUrl);
  const sources = url ? avatarImageSources(url) : [];
  // Each failure moves to the next candidate; once all failed the generated circle stays.
  const [failure, setFailure] = useState<{ url: string; count: number }>({ url: "", count: 0 });
  const failedCount = failure.url === url ? failure.count : 0;
  const src = sources[failedCount] ?? null;
  const failed = () => setFailure({ url: url ?? "", count: failedCount + 1 });
  const avatar = src ? (
      // A remote avatar of any host; next/image would need every host configured.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        key={src}
        ref={(image) => {
          // An image that failed before hydration never fires onError.
          if (image?.complete && image.naturalWidth === 0) failed();
        }}
        alt=""
        className={styles.avatar}
        decoding="async"
        height={size}
        loading="lazy"
        onError={failed}
        referrerPolicy="no-referrer"
        src={src}
        width={size}
      />
    ) : (
    <svg
      aria-hidden="true"
      className={styles.avatar}
      data-avatar="generated"
      height={size}
      viewBox="0 0 1 1"
      width={size}
    >
      <IdentityGradient identity={accountId} />
    </svg>
  );
  return ring ? (
    <span aria-hidden="true" className={styles.ring} data-card-edition={ring.edition} {...dyn({ width: size, height: size })}>
      {avatar}
      {/* This ring is extracted from the approved card's frame gradient. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img alt="" className={styles.ringArtwork} height={size} src={ring.source} width={size} />
    </span>
  ) : avatar;
}
