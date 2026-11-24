"use client";

import {
  ballFlight,
  ballScale,
  ballShake,
  centreOf,
  FEEL_BALL_SHAKE_EXIT_MS,
  type FeelPoint,
  type FeelRect,
} from "./feel-hold.ts";
import type { FeelScope } from "./feel-scope.ts";
import styles from "./feel.module.css";

/**
 * The ball, painted (FEEL-LAYER.md §2).
 *
 * It is created imperatively rather than rendered, for three reasons: it is
 * `position: fixed` and must not sit under any surface's transform or overflow,
 * it must add nothing to the server's HTML (so there is no hydration surface
 * and no layout shift), and it lives for 460 ms — shorter than it is worth
 * re-rendering a tree for.
 *
 * Where it goes (R3-13): into the app's root (`[data-blast-ui]`), the shell's
 * overlay layer, so it wears the shell's tokens (`--pink`, `--pink-ink`) —
 * appended to `document.body` it would have none — and at `z-index: 75`,
 * above Blast mode (60) and its popovers (70) but **below any open sheet or
 * dialog** (80) and the toasts (90). It is `aria-hidden` and takes no pointer
 * events.
 *
 * Every node it creates is registered with the caller's `FeelScope`, so a
 * surface that unmounts mid-flight takes the ball with it and `feelActive()`
 * goes back to zero.
 */

/** Resolved after the ball has landed and been removed, or at once when it could not fly. */
export type FeelBallLanding = Promise<void>;

type BallHost = Readonly<{
  document: Document;
  /** Its timers (the flight's safety net, the shake's exit) and its node's owner. */
  scope: Pick<FeelScope, "after" | "own">;
  /** The app's root the ball joins (`[data-blast-ui]`); the body when there is none. */
  parent?: Element | null;
}>;

function create(host: BallHost, at: FeelPoint, scale: number): { node: HTMLElement; release: () => void } {
  const node = host.document.createElement("div");
  node.className = styles.ball ?? "";
  node.setAttribute("aria-hidden", "true");
  node.style.left = `${at.x}px`;
  node.style.top = `${at.y}px`;
  node.style.setProperty("--feel-ball-scale", String(scale));
  (host.parent ?? host.document.body).appendChild(node);
  const release = host.scope.own(node);
  return { node, release };
}

/**
 * The ball springs out of `button`, arcs over and lands at `landing`. Resolves
 * when it has landed and gone. With no landing point, or anywhere animation is
 * unavailable, it resolves at once and never appears — the caller then commits
 * without a flight, which is also exactly what reduced motion does.
 */
export function flyBall(host: BallHost, button: FeelRect, landing: FeelPoint | null, level: number): FeelBallLanding {
  if (!landing || typeof host.document.body === "undefined") return Promise.resolve();
  const from = centreOf(button);
  const scale = ballScale(level);
  const { node, release } = create(host, from, scale);
  const flight = ballFlight(from, landing, scale);
  if (typeof node.animate !== "function") {
    release();
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      release();
      resolve();
    };
    const animation = node.animate(flight.keyframes as Keyframe[], flight.options);
    animation.onfinish = finish;
    animation.oncancel = finish;
    // A tab hidden mid-flight can leave an animation unfinished; the scope's
    // own timer closes it out rather than leaving a node on the page.
    host.scope.after(finish, flight.options.duration === undefined ? 0 : Number(flight.options.duration) + 120);
  });
}

/**
 * The quote came back an error: the ball shakes where it stands and leaves.
 * Resolves when it has gone.
 */
export function shakeBall(host: BallHost, button: FeelRect, level: number): FeelBallLanding {
  const from = centreOf(button);
  const { node, release } = create(host, from, ballScale(level));
  if (typeof node.animate === "function") {
    const shake = ballShake();
    node.animate(shake.keyframes as Keyframe[], shake.options);
  }
  return new Promise<void>((resolve) => {
    host.scope.after(() => {
      release();
      resolve();
    }, FEEL_BALL_SHAKE_EXIT_MS);
  });
}

/** The fill's brightness flash as the ball lands (the gate's `bxFlash`: .9 s, brightest at 30 %). */
export const FEEL_BAR_FLASH_MS = 900;

/**
 * The bar flashes as the ball lands in it: each `[data-bar]` fill inside it
 * brightens and settles, as the gate's `.bar.flash i` does. Nothing is added
 * to the bar's classes, so a re-render cannot fight it.
 */
export function flashBar(bar: Element): void {
  const fills = [...bar.querySelectorAll("[data-bar]")];
  for (const fill of fills.length > 0 ? fills : [bar]) {
    if (typeof (fill as HTMLElement).animate !== "function") continue;
    (fill as HTMLElement).animate(
      [{ filter: "none" }, { filter: "brightness(1.45) saturate(1.3)", offset: 0.3 }, { filter: "none" }],
      { duration: FEEL_BAR_FLASH_MS, easing: "cubic-bezier(.4, 0, .2, 1)" },
    );
  }
}

/** Where a bar sits near a Blast button: the post, the card, the section or the phone's commit bar it is in. */
const BAR_SCOPE = "article, section, [data-feel-bar-scope]";

/**
 * The sale's bar the ball flies into (the gate's `barFor`): the track of a
 * `[data-bar="<presale id>"]` fill near the pressed button — in the same post,
 * card or section — else any visible one on the page (a post has no bar of
 * its own, so its ball lands in the sale's bar in the right column or Today
 * on Blast). Null when none is on screen: then there is no flight.
 */
export function feelBarFor(button: Element, presaleId: string): Element | null {
  const view = button.ownerDocument.defaultView;
  const height = view?.innerHeight ?? 0;
  const selector = `[data-bar="${presaleId.replace(/["\\]/g, "\\$&")}"]`;
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.bottom > 0 && rect.top < height;
  };
  const track = (root: ParentNode | null): Element | null => {
    if (!root) return null;
    for (const fill of root.querySelectorAll(selector)) {
      const bar = fill.parentElement;
      if (bar && visible(bar)) return bar;
    }
    return null;
  };
  return track(button.closest(BAR_SCOPE)) ?? track(button.ownerDocument);
}

/** The class a charging Blast button wears, and the custom property it reads. */
export const FEEL_CHARGING_CLASS: string = styles.charging ?? "";
/** The class the sound button wears, for its 34 → 44 px sizing. */
export const FEEL_SOUND_BUTTON_CLASS: string = styles.soundButton ?? "";
