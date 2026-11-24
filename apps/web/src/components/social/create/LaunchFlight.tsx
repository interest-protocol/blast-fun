"use client";

import { createPortal } from "react-dom";
import { useDevicePrefs } from "#web/components/blast-ui/device-prefs.ts";
import { useReducedMotion } from "#web/components/blast-ui/use-shell-prefs.ts";
import { cx } from "./cx";

/** The shared, preference-aware rocket flight above the publishing sheet; `onLanded` runs when it leaves the screen. */
export function LaunchFlight({ active, portal, onLanded }: Readonly<{ active: boolean; portal: HTMLElement | null; onLanded?: () => void }>) {
  const { celebrate } = useDevicePrefs();
  const reducedMotion = useReducedMotion();
  if (!active || !celebrate || reducedMotion || !portal) return null;
  return createPortal(
    <div aria-hidden="true" className={cx("cr-launch-flight")}>
      <div className={cx("cr-launch-rocket")}
        onAnimationEnd={({ currentTarget, target }) => {
          if (target !== currentTarget) return;
          currentTarget.dataset.flying = "false";
          onLanded?.();
        }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- pre-sized transparent 54 KB sprite */}
        <img alt="" draggable={false} height={480} loading="eager"
          onError={onLanded}
          onLoad={({ currentTarget }) => { currentTarget.parentElement!.dataset.flying = "true"; }}
          src="/celebration/blast-piloted-rocket.webp" width={720} />
      </div>
    </div>, portal,
  );
}
