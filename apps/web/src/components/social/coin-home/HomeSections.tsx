"use client";

import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";

import { prefersReducedMotion } from "#web/components/blast-ui/use-shell-prefs.ts";
import { EASE_OUT, T3 } from "#web/components/blast-ui/motion-tokens.ts";

import styles from "./CoinHome.module.css";
import { useTablePageMotion } from "./use-table-page-motion";
import { CloseGlyph, GripGlyph } from "./glyphs";
import {
  HOME_SECTION_TITLES,
  moveHomeSection,
  placeHomeSection,
  sectionGripLabel,
  sectionMovedMessage,
  sectionSlotStep,
  setHomeSectionShown,
  shownHomeSections,
  springPath,
  type HomeSectionKey,
  type HomeSectionPrefs,
} from "./home-sections";

/**
 * Home's sections in the device's order, each under a header that is its
 * handle: the title, anything the section puts beside it (a link), its grip
 * and its hide control. A section moves by its grip — dragged 1:1 from where
 * it was grabbed, its neighbours sliding aside as its centre passes theirs
 * (the right column's rule), or walked one slot at a time with ArrowUp and
 * ArrowDown, which does exactly what the drag does — and Escape puts a
 * dragged section back where it was picked up. Hide takes the section off
 * the page (the Sections menu in the bar brings it back). Every move is
 * announced into a polite live region, and every change is remembered on
 * the device (`use-home-sections.ts`), so the next page load lays the
 * sections out this way and reads nothing for the hidden ones.
 *
 * The pointer path is the platform's: the drag's events read on the
 * document (a reorder moves the section's node, which would drop a capture),
 * a 4 px lift so a press stays a press, `touch-action: none` on the grip.
 * The section follows the pointer 1:1 from where it was grabbed; on release
 * it settles on a critically damped spring that starts at its on-screen
 * offset and the pointer's speed, and a section grabbed mid-settle is taken
 * from where it is drawn. The motion is transform only, through the CSSOM
 * and WAAPI (the CSP allows no inline style attributes). Under reduced
 * motion nothing animates: the order changes at once and a dragged section
 * follows the pointer without lifting.
 */

export type SectionChange = Readonly<{ key: HomeSectionKey; action: "move" | "hide" | "show"; position: number }>;

/** The bar's Sections button, which takes the focus when the section it was on is hidden. */
export const HOME_SECTIONS_MENU_ID = "home-sections-menu";

/**
 * A section as the Main board draws it: the title row (the 20/650 title and
 * whatever the section puts on its line), then the section's own surface —
 * a table card (`TableCard`) or the presales' row of cards — under it.
 */
export type SectionSpec = Readonly<{
  /** Drawn in the header, before the grip (a link to the section's own page). */
  tools?: ReactNode;
  title?: ReactNode;
  children: ReactNode;
}>;

type Props = Readonly<{
  prefs: HomeSectionPrefs;
  onChange: (next: HomeSectionPrefs, change: SectionChange | null) => void;
  sections: Readonly<Record<HomeSectionKey, SectionSpec>>;
  /** Drawn where the sections would be when every one is hidden. */
  empty: ReactNode;
  customizing?: boolean;
  launchpad?: boolean;
}>;

/** How far the pointer travels before a section lifts. */
const DRAG_START_PX = 4;
/** The shell's drag state on `body` (globals.css: a grabbing cursor, no text selection). */
const DRAGGING_BODY_CLASS = "blast-card-dragging";

type Drag = {
  key: HomeSectionKey;
  pointerId: number;
  /** Removes the drag's document listeners. */
  /** The pointer's y where it was pressed. */
  y0: number;
  /** The section's layout top when it lifted. */
  top0: number;
  /** The section's offset from its slot, as drawn. */
  y: number;
  /** The preferences when it lifted, for a cancel. */
  from: HomeSectionPrefs;
  lifted: boolean;
  /** The last pointer samples, for the velocity at release. */
  samples: { t: number; y: number }[];
};

/** Where a section is drawn right now, from its computed transform (an animation in flight included). */
function drawnY(element: HTMLElement): number {
  const transform = getComputedStyle(element).transform;
  return transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m42;
}

/** The pointer's speed over its last samples (px/s), 0 when it paused. */
function releaseVelocity(samples: readonly { t: number; y: number }[]): number {
  const last = samples[samples.length - 1];
  const earlier = samples.find((sample) => last !== undefined && last.t - sample.t <= 80);
  if (!last || !earlier || last.t === earlier.t) return 0;
  return ((last.y - earlier.y) / (last.t - earlier.t)) * 1000;
}

const keyOf = (element: HTMLElement): HomeSectionKey => element.dataset.section as HomeSectionKey;
const boxOf = (element: HTMLElement | undefined) => element && { top: element.offsetTop, height: element.offsetHeight };

/** A stylesheet's entrance (an open card's, a thread's) restarts when React moves a section's node; a move is not a first paint. */
function finishEntrances(element: HTMLElement): void {
  for (const animation of element.getAnimations({ subtree: true })) {
    if ("animationName" in animation && animation.effect?.getComputedTiming().endTime !== Infinity) animation.finish();
  }
}

export function HomeSections({ prefs, onChange, sections, empty, customizing = false, launchpad = false }: Props) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  useTablePageMotion(root);
  const live = useRef<HTMLSpanElement>(null);
  /** The preferences as last committed: the drag's loop reads them after each synchronous reorder. */
  const latest = useRef(prefs);
  useLayoutEffect(() => {
    latest.current = prefs;
  }, [prefs]);
  const drag = useRef<Drag | null>(null);
  /** Each section's top before a reorder, for the slide that follows it. */
  const before = useRef<Map<HomeSectionKey, number> | null>(null);
  /** The section the slide leaves alone: it is under the pointer, or about to settle on its own. */
  const held = useRef<HomeSectionKey | null>(null);
  const announce = useRef<string | null>(null);
  /** The grip a keyboard move came from, which keeps the focus. */
  const refocus = useRef<HTMLElement | null>(null);

  const elements = (): readonly HTMLElement[] => [...(root.current?.querySelectorAll<HTMLElement>(":scope > [data-section]") ?? [])];
  const elementOf = (key: HomeSectionKey) => elements().find((element) => keyOf(element) === key) ?? null;

  const positionOf = (key: HomeSectionKey) => shownHomeSections(latest.current, launchpad).indexOf(key);

  const reorder = (next: HomeSectionPrefs, change: SectionChange | null, hold: HomeSectionKey | null, tell: string | null) => {
    if (next === latest.current) return;
    before.current = new Map(elements().map((element) => [keyOf(element), element.offsetTop]));
    announce.current = tell;
    held.current = hold;
    // Under a drag the paint must land before the next line reads the section's own offset.
    if (hold) flushSync(() => onChange(next, change));
    else onChange(next, change);
  };

  useLayoutEffect(() => {
    const offsets = before.current;
    before.current = null;
    const skip = held.current;
    held.current = null;
    const told = announce.current;
    announce.current = null;
    if (told && live.current) live.current.textContent = told;
    const grip = refocus.current;
    refocus.current = null;
    if (grip?.isConnected && document.activeElement !== grip) grip.focus({ preventScroll: true });
    if (!offsets) return;
    for (const element of elements()) finishEntrances(element);
    if (prefersReducedMotion()) return;
    for (const element of elements()) {
      const key = keyOf(element);
      if (key === skip) continue;
      const dy = (offsets.get(key) ?? element.offsetTop) - element.offsetTop;
      if (dy) element.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: T3, easing: EASE_OUT });
    }
  }, [prefs]);

  /** Draws the lifted section under the pointer, past each neighbour whose centre its own has passed. */
  const dragTo = (state: Drag, clientY: number) => {
    let element = elementOf(state.key);
    if (!element) return;
    const want = state.top0 + (clientY - state.y0);
    const dragged = { top: want, height: element.offsetHeight };
    for (let guard = 0; guard < 4; guard += 1) {
      const all = elements();
      const index = all.indexOf(element);
      const step = sectionSlotStep(dragged, boxOf(all[index - 1]), boxOf(all[index + 1]));
      if (step === 0) break;
      reorder(placeHomeSection(latest.current, state.key, index + step, launchpad), null, state.key, null);
      element = elementOf(state.key) ?? element;
    }
    state.y = want - element.offsetTop;
    element.style.transform = `translateY(${state.y}px)${prefersReducedMotion() ? "" : " scale(1.01)"}`;
  };

  const settle = (state: Drag, cancel: boolean) => {
    document.body.classList.remove(DRAGGING_BODY_CLASS);
    let element = elementOf(state.key);
    if (!element) return;
    if (cancel) {
      const at = element.offsetTop + state.y;
      reorder(state.from, null, state.key, null);
      element = elementOf(state.key) ?? element;
      state.y = at - element.offsetTop;
    }
    const section = element;
    section.style.transform = "";
    if (prefersReducedMotion()) section.removeAttribute("data-lifted");
    else {
      // The settle starts where the section was let go and at the pointer's speed (a spring, critically damped).
      const path = springPath(state.y, cancel ? 0 : releaseVelocity(state.samples));
      const settle = section.animate(
        path.map((y, index) => ({ transform: `translateY(${y}px) scale(${1 + 0.01 * (1 - index / (path.length - 1))})` })),
        { duration: 540, easing: "linear" },
      );
      settle.onfinish = () => section.removeAttribute("data-lifted");
    }
    const position = positionOf(state.key);
    if (live.current) live.current.textContent = sectionMovedMessage(state.key, position, shownHomeSections(latest.current, launchpad).length);
    if (!cancel && latest.current !== state.from) onChange(latest.current, { key: state.key, action: "move", position });
  };

  /** Ends a drag: the listeners go, and a lifted section settles (or goes back where it was picked up). */
  const end = (state: Drag, cancel: boolean) => {
    drag.current = null;
    if (state.lifted) settle(state, cancel);
  };

  /**
   * A press on the grip starts listening on the document: a reorder moves
   * the section's node, which drops any pointer capture the grip held, so
   * the drag's events are read where they always arrive. The section lifts
   * once the pointer has travelled 4 px; Escape puts it back; the browser's
   * own cancel leaves it where it is, as a release does.
   */
  const onGripPointerDown = (key: HomeSectionKey, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (drag.current || (event.pointerType === "mouse" && event.button !== 0)) return;
    const element = elementOf(key);
    if (!element) return;
    // Grabbed mid-settle: the section is taken from where it is drawn, and the settle is dropped, so nothing jumps.
    const inFlight = drawnY(element);
    for (const animation of element.getAnimations()) animation.cancel();
    const state: Drag = {
      key, pointerId: event.pointerId, y0: event.clientY - inFlight, top0: element.offsetTop, y: inFlight, from: latest.current,
      lifted: inFlight !== 0, samples: [{ t: event.timeStamp, y: event.clientY }],
    };
    if (state.lifted) {
      element.style.transform = `translateY(${inFlight}px)${prefersReducedMotion() ? "" : " scale(1.01)"}`;
      element.setAttribute("data-lifted", "");
      document.body.classList.add(DRAGGING_BODY_CLASS);
    }
    drag.current = state;
  };

  const onDragMove = useEffectEvent((move: globalThis.PointerEvent) => {
    const state = drag.current;
    if (!state || move.pointerId !== state.pointerId) return;
    state.samples.push({ t: move.timeStamp, y: move.clientY });
    if (state.samples.length > 8) state.samples.shift();
    if (!state.lifted) {
      if (Math.abs(move.clientY - state.y0) < DRAG_START_PX) return;
      state.lifted = true;
      elementOf(state.key)?.setAttribute("data-lifted", "");
      document.body.classList.add(DRAGGING_BODY_CLASS);
    }
    dragTo(state, move.clientY);
  });
  const onDragEnd = useEffectEvent((event: globalThis.PointerEvent) => {
    const state = drag.current;
    if (state && event.pointerId === state.pointerId) end(state, false);
  });
  const onDragKey = useEffectEvent((event: globalThis.KeyboardEvent) => {
    const state = drag.current;
    if (event.key !== "Escape" || !state?.lifted) return;
    event.preventDefault();
    end(state, true);
  });

  const onGripKeyDown = (key: HomeSectionKey, event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    refocus.current = event.currentTarget;
    const next = moveHomeSection(latest.current, key, event.key === "ArrowUp" ? -1 : 1, launchpad);
    const position = shownHomeSections(next, launchpad).indexOf(key);
    reorder(next, { key, action: "move", position }, null, sectionMovedMessage(key, position, shownHomeSections(next, launchpad).length));
  };

  const hide = (key: HomeSectionKey) => {
    const position = positionOf(key);
    const next = setHomeSectionShown(latest.current, key, false);
    const others = elements().filter((element) => keyOf(element) !== key);
    refocus.current = others[Math.min(position, others.length - 1)]?.querySelector<HTMLElement>("[data-grip]") ?? document.getElementById(HOME_SECTIONS_MENU_ID) ?? null;
    reorder(next, { key, action: "hide", position }, null, `${HOME_SECTION_TITLES[key]} hidden. Show it again from Sections.`);
  };

  // Document listeners survive a section reorder and are released with Home.
  useEffect(() => {
    const move = (event: globalThis.PointerEvent) => onDragMove(event);
    const release = (event: globalThis.PointerEvent) => onDragEnd(event);
    const key = (event: globalThis.KeyboardEvent) => onDragKey(event);
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", release);
    document.addEventListener("pointercancel", release);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", release);
      document.removeEventListener("pointercancel", release);
      document.removeEventListener("keydown", key);
      drag.current = null;
      document.body.classList.remove(DRAGGING_BODY_CLASS);
    };
  }, []);

  const shown = shownHomeSections(prefs, launchpad);
  return (
    <div className={styles.sections} ref={root}>
      {shown.map((key) => {
        const spec = sections[key];
        return (
          <section aria-labelledby={`${id}-${key}`} className={styles.section} data-section={key} key={key}>
            <header className={styles.sectionHead}>
              <h2 id={`${id}-${key}`}>{spec.title ?? HOME_SECTION_TITLES[key]}</h2>
              <div className={styles.sectionTools}>
                {spec.tools}
                {customizing ? <>
                <button
                  aria-label={sectionGripLabel(key)}
                  className={styles.grip}
                  data-grip=""
                  onKeyDown={(event) => onGripKeyDown(key, event)}
                  onPointerDown={(event) => onGripPointerDown(key, event)}
                  title="Drag to reorder"
                  type="button"
                >
                  <GripGlyph />
                </button>
                <button aria-label={`Hide ${HOME_SECTION_TITLES[key]}`} className={styles.hide} onClick={() => hide(key)} title="Hide this section" type="button">
                  <CloseGlyph />
                </button>
                </> : null}
              </div>
            </header>
            {spec.children}
          </section>
        );
      })}
      {shown.length === 0 ? empty : null}
      <span aria-live="polite" className="sr" ref={live} />
    </div>
  );
}
