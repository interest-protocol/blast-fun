"use client";

import { useId } from "react";
import { identityHue } from "./identity-gradient.ts";

/** The wallet avatar's existing gradient, stable for an identity at every size. */
export function IdentityGradient({ identity }: Readonly<{ identity: string }>) {
  const id = useId();
  const hue = identityHue(identity);
  return (
    <>
      <defs>
        <linearGradient id={id} x1="0.047" x2="0.953" y1="-0.04" y2="1.04">
          <stop offset="0" stopColor={`hsl(${hue} 70% 66%)`} />
          <stop offset="1" stopColor={`hsl(${(hue + 52) % 360} 64% 50%)`} />
        </linearGradient>
      </defs>
      <rect fill={`url(#${id})`} height="1" width="1" />
    </>
  );
}
