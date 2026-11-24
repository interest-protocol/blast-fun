"use client";
import { quoteDisplaySymbol } from "./quote-coins";

import { useLayoutEffect, useRef } from "react";
import { useAnimate } from "motion/react";

import { DexIdentity } from "#web/components/blast-ui/DexIdentity.tsx";
import { useReducedMotion } from "#web/components/blast-ui/use-shell-prefs.ts";
import { useHydrated } from "#web/components/ui-libraries/use-hydrated.tsx";
import type { LaunchVenue } from "@blast/core/modules/social/launch/model.ts";
import { CheckIcon } from "./create-icons";
import { CoinMark } from "./fields";
import { QuoteMark } from "./QuotePicker";
import { cx } from "./cx";

/**
 * The user's own logo becomes the coin's face; the depth and machinery are live CSS geometry.
 * Each publishing step has its own pose: the coin forges (0), the registry orbits it (1), the
 * quote coin joins it on the venue's platform (2, 3), and a seal lands when it is published.
 * Presale publishing and bonding-curve launches share it. The scene has no caption: the sheet's
 * title and steps say the state, and words inside the scaled scene would fall under 12px.
 */
export function CreateLaunchScene({ name, symbol, logo, quoteSymbol, venue, stage, published }: Readonly<{ name: string; symbol: string; logo: string | null; quoteSymbol: string; venue: LaunchVenue; stage: number; published: boolean }>) {
  const [scope, animate] = useAnimate<HTMLDivElement>();
  const reduced = useReducedMotion();
  const hydrated = useHydrated();
  const previous = useRef<number | null>(null);
  const paired = stage >= 2;
  const coinTransform = paired ? "translateX(-58px) translateY(-16px) rotateZ(-8deg)" : "translateX(0px) translateY(-16px) rotateZ(-8deg)";

  useLayoutEffect(() => {
    if (!hydrated || !scope.current) return;
    const controls = animate(".cr-launch-coin", { transform: coinTransform }, { type: "spring", duration: reduced || previous.current === null ? 0 : .5, bounce: 0 });
    previous.current = stage;
    return () => controls.stop();
  }, [animate, coinTransform, hydrated, reduced, scope, stage]);

  return <div aria-hidden="true" className={cx("cr-launch-scene")} data-motion={hydrated && !reduced} ref={scope}>
    <span className={cx("cr-launch-grid")} />
    <span className={cx("cr-launch-halo")} />
    <div className={cx("cr-launch-registry")}>
      <span className={cx("cr-launch-orbit cr-launch-orbit-one")}><i /><i /><i /></span>
      <span className={cx("cr-launch-orbit cr-launch-orbit-two")}><i /><i /></span>
      <span className={cx("cr-launch-orbit cr-launch-orbit-three")} />
    </div>
    <span className={cx("cr-launch-spark cr-launch-spark-one")}>✦</span>
    <span className={cx("cr-launch-spark cr-launch-spark-two")}>✧</span>
    <span className={cx("cr-launch-spark cr-launch-spark-three")}>✦</span>
    <div className={cx("cr-launch-coin")}>
      <div className={cx("cr-launch-coin-volume")}>
        <span className={cx("cr-launch-coin-back")}>✦</span>
        {Array.from({ length: 8 }, (_, index) => <span className={cx("cr-launch-coin-edge")} key={index} />)}
        <span className={cx("cr-launch-coin-face")}><CoinMark draft={{ name }} logo={logo} size="s72" /></span>
        <span className={cx("cr-launch-coin-shine")} />
      </div>
      <span className={cx("cr-launch-ticker")}>${symbol}</span>
    </div>
    <span className={cx("cr-launch-connect")}><i /><i /><i /></span>
    <div className={cx("cr-launch-quote")}>
      <span className={cx("cr-launch-quote-volume")}><QuoteMark symbol={quoteSymbol} size={34} /></span>
      <span className={cx("cr-launch-ticker")}>{quoteDisplaySymbol(quoteSymbol)}</span>
    </div>
    <div className={cx("cr-launch-platform")}><span /><span /><span /></div>
    <span className={cx("cr-launch-venue")}><DexIdentity venue={venue} /></span>
    {published ? <span className={cx("cr-launch-seal")}><CheckIcon /></span> : null}
  </div>;
}
