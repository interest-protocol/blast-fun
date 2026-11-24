"use client";

import { useId } from "react";
import { pctText } from "@blast/core/modules/social/create/model.ts";

import { useStyleNonce } from "#web/components/ui-libraries/style-nonce.tsx";

/** A split bar (`.split-bar`): one rounded segment per positive share, in order. */
export function SplitBar({ parts }: Readonly<{ parts: readonly (readonly [number, string, string])[] }>) {
  const id = useId();
  const nonce = useStyleNonce();
  const segments = parts.filter(([bps]) => Number.isFinite(bps) && bps > 0);
  // The request nonce authorizes calculated widths in the first HTML response.
  const rules = segments.map(([bps], index) => `[data-cr-split="${id}"] > i:nth-child(${index + 1}) { flex: ${bps}; }`).join("\n");
  return (
    <>
      <style nonce={nonce}>{rules}</style>
      <div className="split-bar" data-cr-split={id}>
        {segments.map(([bps, color, label], index) => (
          <i className="cr-color" data-cr-color={color} key={index} title={`${label} ${pctText(bps)}`} />
        ))}
      </div>
    </>
  );
}
