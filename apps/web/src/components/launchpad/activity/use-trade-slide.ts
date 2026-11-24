import { useLayoutEffect, type RefObject } from "react";
import { EASE_OUT, T3 } from "#web/components/blast-ui/motion-tokens.ts";

/** Move existing rows down by one row as the latest trade enters. */
export function useTradeSlide(list: RefObject<HTMLOListElement | null>, entering?: string | null, slide?: boolean) {
  useLayoutEffect(() => {
    const track = list.current;
    const first = track?.children[0];
    const second = track?.children[1];
    if (!slide || !entering || !track?.animate || !(first instanceof HTMLElement)) return;
    const distance = second instanceof HTMLElement ? second.offsetTop - first.offsetTop : first.offsetHeight;
    const animation = track.animate(
      [{ transform: `translateY(${-distance}px)` }, { transform: "none" }],
      { duration: T3, easing: EASE_OUT },
    );
    return () => animation.cancel();
  }, [list, entering, slide]);
}
