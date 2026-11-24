"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";

import { FEEL_CHARGING_CLASS, flashBar, flyBall, shakeBall } from "./feel-ball.ts";
import { useFeel } from "./FeelProvider.tsx";
import { barLandingPoint, FEEL_HOLD_AMOUNTS_USD, holdAmountUsd } from "./feel-hold.ts";
import { FeelHoldGesture, holdScopeOnTasks, type HoldRelease, type HoldScope, type HoldTimers } from "./feel-hold-gesture.ts";
import { runHeldRelease } from "./feel-hold-release.ts";
import { FeelScope } from "./feel-scope.ts";
import { motionAllowed } from "./feel-sound-pref.ts";

/**
 * Hold to blast, for one Blast button (R3-13; FEEL-LAYER.md §2).
 *
 * The gesture itself is `FeelHoldGesture` — the press, the 220 ms arm, the
 * 650 ms ladder bounded by what the viewer can spend, every cancel path and
 * the one swallowed click — and this hook gives it a button and a release:
 *
 * 1. **the quote** (`quote`), at the release, before anything flies: a refusal
 *    plays `error`, shakes the ball where it stands for 220 ms, removes it and
 *    hands its own words to `onRefused` (the surface toasts them). Nothing is
 *    sent;
 * 2. **the flight**: `fire`, then the ball arcs into the sale's bar
 *    (`bar`, at the raise's own fill) and the bar flashes. Under reduced
 *    motion there is no ball at all and the commit goes at once;
 * 3. **the commit** (`onBlast`). The ball is not the success signal: the
 *    commit's own result is — the host plays `land` or `error` and toasts, and
 *    the bar's new figures come from the route's answer. A rejection here is
 *    a failure the host did not report, so it plays `error` and says so.
 *
 * Every timer and listener belongs to the Feel layer's scope — or, inside
 * Blast mode, to the mode's own task registry (`tasks`, R3-60), so they stop
 * with the mode — and every ball to the layer's scope, so a surface that
 * unmounts mid-hold takes its press and its balls with it, and the provider
 * removes any ball still flying when the route changes.
 */

export type FeelHoldOptions = Readonly<{
  /** Off entirely when the viewer cannot blast here: signed out, sale not open, no commit host, a panel open on it. */
  enabled: boolean;
  /** What the viewer can spend, in dollars: a value, or a getter read at every step. Null while the wallet has not answered. */
  availableUsd: number | null | (() => number | null);
  /** The sale's name, for the charging button's accessible name (`holdAriaLabel`). */
  saleName: string;
  /** How full the sale is (0..1), for where along its bar the ball lands. */
  fill?: number | null;
  /** The sale's bar for the pressed button (`feelBarFor`). Without one there is no flight, only the commit. */
  bar?: (button: HTMLElement) => Element | null;
  /** The press began: warm whatever the release will need (the commit quote's reads). */
  onPress?: () => void;
  /** The quote at the release: the refusal's own words, or null to go. */
  quote?: (amountUsd: number) => string | null | Promise<string | null>;
  /** A refusal to show (the surface toasts it). */
  onRefused?: (message: string) => void;
  /** The commit, with no sheet. It reports its own outcome (sound and toast). */
  onBlast: (amountUsd: number) => Promise<void>;
  /** Overridable for a surface with its own ladder; the gate's is the default. */
  amountsUsd?: readonly number[];
  /**
   * A timer registry to run the hold's timers and listeners on instead of the
   * Feel layer's scope: Blast mode's (R3-60's `BlastTasks`), so nothing the
   * hold schedules outlives the mode.
   */
  tasks?: HoldTimers;
}>;

export type FeelHoldProps = Readonly<{
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  /** A long press on a touch screen opens the browser's menu over a link: not while a hold is down. */
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
}>;

export type FeelHold = Readonly<{
  /** Spread on the Blast button. */
  holdProps: FeelHoldProps;
  /** True from the moment the charge arms until the release or a cancel. */
  charging: boolean;
  /** 0-based rung of the ladder while charging. */
  level: number;
  /** The amount the charge stands at, in USD. */
  amountUsd: number;
  /** The amount being quoted and sent after a release, until its answer; null otherwise. */
  sendingUsd: number | null;
  /** The class and custom property the glow needs, while charging. */
  chargeClassName: string;
  chargeStyle: CSSProperties | undefined;
  /** True from the release until the commit has answered. */
  blasting: boolean;
}>;

/** What a held press said, as the button draws it: the charging rung, or the amount on its way. */
type Shown = Readonly<{ charging: number | null; sendingUsd: number | null }>;

const NOTHING: Shown = Object.freeze({ charging: null, sendingUsd: null });

export function useFeelHold(options: FeelHoldOptions): FeelHold {
  const { play, provided, scopeRef } = useFeel();
  const [shown, setShown] = useState<Shown>(NOTHING);
  const ownScopeRef = useRef<FeelScope | null>(null);
  const gestureRef = useRef<{ gesture: FeelHoldGesture; owner: FeelScope | HoldTimers } | null>(null);
  /** The balls this surface put on the page: they go when it unmounts, whoever owns the timers. */
  const balls = useRef(new Set<{ remove(): void }>());
  /** The button the current press is on. */
  const pressed = useRef<HTMLElement | null>(null);
  /** A released hold is still being quoted or sent: no second hold until it has answered. */
  const sending = useRef(false);
  const amountsUsd = options.amountsUsd ?? FEEL_HOLD_AMOUNTS_USD;
  // Handlers read the latest options rather than the ones they closed over,
  // so a press that began a render ago still commits the right amount.
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  // A hook used outside the provider still has to be cleanable, so it keeps a
  // scope of its own. Created after mount; nothing measures the DOM before.
  useEffect(() => {
    if (provided) return undefined;
    const scope = new FeelScope(window);
    ownScopeRef.current = scope;
    return () => {
      scope.stop();
      ownScopeRef.current = null;
    };
  }, [provided]);

  // A surface that unmounts mid-press takes its press, and any ball it threw, with it.
  useEffect(() => {
    const thrown = balls.current;
    return () => {
      gestureRef.current?.gesture.dispose();
      gestureRef.current = null;
      for (const ball of thrown) ball.remove();
      thrown.clear();
    };
  }, []);

  const released = useCallback(
    async (release: HoldRelease, button: HTMLElement, scope: FeelScope, timers: HoldScope) => {
      const rect = button.getBoundingClientRect();
      const thrown = balls.current;
      const ballScope = {
        after: (handler: () => void, ms: number) => timers.after(handler, ms),
        own: (node: { remove(): void }) => {
          const release = scope.own(node);
          thrown.add(node);
          return () => {
            thrown.delete(node);
            release();
          };
        },
      };
      const host = { document: button.ownerDocument, scope: ballScope, parent: button.closest("[data-blast-ui]") };
      const now = latest.current;
      // The bar is found once, at the release: where the ball lands and what flashes.
      let bar: Element | null = null;
      sending.current = true;
      setShown({ charging: null, sendingUsd: release.amountUsd });
      return await (async () => {
        await runHeldRelease({
          amountUsd: release.amountUsd,
          play,
          motion: motionAllowed(),
          quote: (amountUsd) => latest.current.quote?.(amountUsd) ?? null,
          landing: () => {
            bar = now.bar?.(button) ?? null;
            return bar ? barLandingPoint(bar.getBoundingClientRect(), now.fill ?? 0, 1) : null;
          },
          shake: () => shakeBall(host, rect, release.level),
          fly: (landing) => flyBall(host, rect, landing, release.level),
          flash: () => {
            if (bar) flashBar(bar);
          },
          commit: (amountUsd) => latest.current.onBlast(amountUsd),
          refused: (message) => latest.current.onRefused?.(message),
        });
      })().finally(() => {
        sending.current = false;
        setShown(NOTHING);
      });
    },
    [play],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const current = latest.current;
      const scope = provided ? scopeRef.current : ownScopeRef.current;
      // While a held blast is on its way, a press is only a press: one commit at a time.
      if (!scope || scope.stopped || !current.enabled || event.button > 0 || sending.current) return;
      const button = event.currentTarget;
      if (button.hasAttribute("disabled") || button.getAttribute("aria-disabled") === "true") return;
      let held = gestureRef.current;
      const owner = current.tasks ?? scope;
      if (!held || held.owner !== owner) {
        held?.gesture.dispose();
        const timers: HoldScope = current.tasks ? holdScopeOnTasks(current.tasks) : scope;
        const gesture: FeelHoldGesture = new FeelHoldGesture({
          scope: timers,
          events: button.ownerDocument.defaultView ?? button.ownerDocument,
          clicks: button.ownerDocument,
          play,
          availableUsd: () => {
            const available = latest.current.availableUsd;
            return typeof available === "function" ? available() : available;
          },
          amounts: latest.current.amountsUsd ?? FEEL_HOLD_AMOUNTS_USD,
          onCharge: (level) => setShown((was) => (level === null ? { ...was, charging: null } : { charging: level, sendingUsd: null })),
          onRelease: (release) => {
            const target = pressed.current;
            if (target) void released(release, target, scope, timers);
          },
        });
        held = { gesture, owner };
        gestureRef.current = held;
      }
      pressed.current = button;
      current.onPress?.();
      held.gesture.press({
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        contains: (node) => node instanceof Node && button.contains(node),
      });
    },
    [play, provided, released, scopeRef],
  );
  const onContextMenu = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if ((gestureRef.current?.gesture.phase ?? "idle") !== "idle") event.preventDefault();
  }, []);

  const holdProps = useMemo<FeelHoldProps>(() => ({ onPointerDown, onContextMenu }), [onContextMenu, onPointerDown]);
  const charging = shown.charging !== null;
  const level = shown.charging ?? 0;

  return {
    holdProps,
    charging,
    level,
    amountUsd: holdAmountUsd(level, amountsUsd),
    sendingUsd: shown.sendingUsd,
    chargeClassName: charging ? FEEL_CHARGING_CLASS : "",
    chargeStyle: charging ? ({ "--feel-level": level } as CSSProperties) : undefined,
    blasting: shown.sendingUsd !== null,
  };
}

/** The charging button's label, as the gate words it: "Blast $500". */
export function holdLabel(amountUsd: number, formatUsd: (value: number) => string): string {
  return `Blast ${formatUsd(amountUsd)}`;
}

/** Its accessible name: "Blast $500 into Meridian". */
export function holdAriaLabel(amountUsd: number, saleName: string, formatUsd: (value: number) => string): string {
  return `Blast ${formatUsd(amountUsd)} into ${saleName}`;
}
