"use client";

import { Children, isValidElement, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type AnimationEvent, type FocusEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { useReducedMotion } from "#web/components/blast-ui/use-shell-prefs.ts";
import { IconButton } from "#web/components/blast-ui/Button.tsx";
import { useHydrated } from "#web/components/ui-libraries/use-hydrated.tsx";
import styles from "./FeaturedPresales.module.css";
import { ArrowUpIcon } from "#web/components/blast-ui/Icons.tsx";

function watchVisibility(listener: () => void) {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}
const documentHidden = () => document.hidden;
const serverHidden = () => true;

const slideLabels = { presales: "Presale", launches: "Launch", "bonding curves": "Bonding curve" } as const;
const busyPurchase = '[data-kind="commit"] button[aria-busy="true"]:not([data-visual-copy] *)';

function useCarouselPlayback({ box, track, playbackButton, rememberActive }: Readonly<{
  box: RefObject<HTMLDivElement | null>;
  track: RefObject<HTMLDivElement | null>;
  playbackButton: RefObject<HTMLButtonElement | null>;
  rememberActive: () => void;
}>) {
  const reduced = useReducedMotion();
  const hidden = useSyncExternalStore(watchVisibility, documentHidden, serverHidden);
  const [playing, setPlaying] = useState<boolean | null>(null);
  const [hovered, setHovered] = useState(false);
  const [pending, setPending] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [inView, setInView] = useState(true);
  const automatic = playing ?? !reduced;
  const paused = !automatic || hidden || hovered || !inView || pending || detailsOpen;
  const stopPlayback = () => setPlaying(false);
  useEffect(() => {
    const node = box.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting));
    observer.observe(node);
    return () => observer.disconnect();
  }, [box]);
  useEffect(() => {
    const node = track.current;
    if (!node) return;
    const checkPending = () => {
      const busy = !!node.querySelector(busyPurchase);
      setPending(busy);
      setDetailsOpen(!!node.querySelector('.' + styles.slide + ':not([inert]) details[open]'));
      if (busy) setPlaying(false);
    };
    checkPending();
    const observer = new MutationObserver(checkPending);
    observer.observe(node, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-busy", "open", "inert"] });
    return () => observer.disconnect();
  }, [track]);

  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    rememberActive();
    if (event.nativeEvent.target !== playbackButton.current) {
      stopPlayback();
    }
  };
  const onPointerEnter = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse") {
      rememberActive();
      setHovered(true);
    }
  };
  const onPointerLeave = () => setHovered(false);

  return {
    automatic, paused, pending, reduced,
    stopPlayback: () => {
      rememberActive();
      stopPlayback();
    },
    togglePlayback: () => {
      rememberActive();
      setPlaying(!automatic);
    },
    onFocus, onPointerEnter, onPointerLeave,
  };
}

function slideStep(track: HTMLDivElement, count: number) {
  return (track.scrollWidth - track.clientWidth) / (count + 1);
}

function carouselSlot(track: HTMLDivElement, step: number, count: number) {
  const slot = Math.max(0, Math.min(count + 1, Math.round(track.scrollLeft / step)));
  return { slot, position: slot === 0 ? count : slot === count + 1 ? 1 : slot };
}

function useCarouselPosition(children: ReactNode) {
  const track = useRef<HTMLDivElement>(null);
  const hydrated = useHydrated();
  const [selected, setSelected] = useState<{ key: string; position: number } | null>(null);
  const slides = Children.toArray(children).map((card, index) => ({
    card,
    key: isValidElement(card) && card.key !== null ? card.key : `text:${index}`,
  }));
  const count = slides.length;
  const looping = hydrated && count > 1;
  const slideOrder = JSON.stringify(slides.map(({ key }) => key));
  const selectedIndex = slides.findIndex(({ key }) => key === selected?.key);
  const position = selectedIndex >= 0 ? selectedIndex + 1 : Math.max(1, Math.min(selected?.position ?? 1, count));
  const rememberActive = () => {
    const active = slides[position - 1];
    if (active && active.key !== selected?.key) setSelected({ key: active.key, position });
  };
  const syncSelection = useCallback((slide: Element | undefined, position: number) => {
    const key = slide?.getAttribute("data-slide-key");
    if (!key) return;
    setSelected((current) => {
      // A late answer can still change the opening card until someone uses the carousel or it advances.
      if (!current && position === 1) return current;
      if (current?.key === key && current.position === position) return current;
      return { key, position };
    });
  }, []);
  const measure = useCallback(() => {
    const node = track.current;
    if (!node || !looping) return;
    const step = slideStep(node, count);
    if (step <= 0) return;
    const { slot, position } = carouselSlot(node, step, count);
    syncSelection(node.children[position], position);
    // Once the copy is in view, return to the identical interactive card.
    if (slot !== position && Math.abs(node.scrollLeft - slot * step) < 1) {
      node.scrollTo({ left: position * step, behavior: "instant" });
    }
  }, [count, looping, syncSelection]);
  useLayoutEffect(() => {
    const node = track.current;
    if (!node || !looping) return;
    let aligned = false;
    const align = () => {
      const step = slideStep(node, count);
      if (step <= 0) return;
      if (!aligned) {
        aligned = true;
        const slot = Array.from(node.children).findIndex((slide) => slide.hasAttribute("data-slide-key") && !slide.hasAttribute("inert"));
        node.scrollTo({ left: Math.max(1, slot) * step, behavior: "instant" });
      }
      measure();
    };
    align();
    const observer = new ResizeObserver(align);
    observer.observe(node);
    return () => observer.disconnect();
  }, [count, looping, measure, slideOrder]);
  const scroll = (direction: number, instant: boolean) => {
    const node = track.current;
    if (!node || !looping) return;
    const step = slideStep(node, count);
    if (step <= 0) return;
    const { slot, position } = carouselSlot(node, step, count);
    if (slot !== position) node.scrollTo({ left: position * step, behavior: "instant" });
    node.scrollTo({ left: (position + direction) * step, behavior: instant ? "instant" : "smooth" });
  };
  return { count, looping, measure, position, rememberActive, scroll, slides, track };
}

export function FeaturedCarousel({ children, kind = "presales" }: Readonly<{ children: ReactNode; kind?: keyof typeof slideLabels }>) {
  const box = useRef<HTMLDivElement>(null);
  const playbackButton = useRef<HTMLButtonElement>(null);
  const { count, looping, measure, position, rememberActive, scroll, slides, track } = useCarouselPosition(children);
  const playback = useCarouselPlayback({ box, track, playbackButton, rememberActive });
  const move = (direction: number, keyboard: boolean) => {
    playback.stopPlayback();
    scroll(direction, keyboard || playback.reduced);
  };
  const advance = (event: AnimationEvent<HTMLSpanElement>) => {
    if (event.target !== event.currentTarget || !event.animationName.includes("carousel-fill") || playback.paused || document.hidden || document.querySelector('dialog[open], [aria-modal="true"], [role="region"][aria-label="Blast mode"]')) return;
    const node = track.current;
    if (!node || (node.contains(document.activeElement) && document.activeElement?.closest('[data-kind="commit"]')) || node.querySelector(busyPurchase) || node.querySelector('.' + styles.slide + ':not([inert]) details[open]')) return;
    scroll(1, playback.reduced);
  };

  return (
    <div className={styles.carousel} data-paused={playback.paused || undefined} data-static={playback.reduced && !playback.automatic || undefined} onInputCapture={playback.stopPlayback} onFocusCapture={playback.onFocus} ref={box}>
      <div aria-label={`Featured ${kind}`} aria-roledescription="carousel" className={styles.grid} onPointerDownCapture={playback.stopPlayback} onPointerEnter={playback.onPointerEnter} onPointerLeave={playback.onPointerLeave} onWheelCapture={playback.stopPlayback} onScroll={measure}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
          event.preventDefault();
          move(event.key === "ArrowLeft" ? -1 : 1, true);
        }} ref={track} role="group" tabIndex={0}>
        {looping ? <div aria-hidden="true" className={styles.slide} data-visual-copy inert>{slides.at(-1)?.card}</div> : null}
        {slides.map(({ card, key }, index) => <div aria-hidden={index + 1 !== position || undefined} className={styles.slide} data-slide-key={key} inert={index + 1 !== position} key={key}>{card}</div>)}
        {looping ? <div aria-hidden="true" className={styles.slide} data-visual-copy inert>{slides[0]?.card}</div> : null}
      </div>
      <div className={styles.controls}>
        {count > 1 ? <>
          {/* One thin segment per slide; the current one fills in ink while its slide is shown. */}
          <span aria-hidden="true" className={styles.segments}>
            {Array.from({ length: count }, (_, index) => <span className={styles.segment} data-current={index + 1 === position || undefined} key={index}>
              {index + 1 === position ? <span className={styles.timer} key={`${count}-${position}`} onAnimationEnd={advance} /> : null}
            </span>)}
          </span>
          <span aria-label={`${slideLabels[kind]} ${position} of ${count}`} aria-live={playback.automatic ? "off" : undefined} className={`${styles.position} sr-only`} role="status">{position} / {count}</span>
          <span className={`${styles.playbackStatus} sr-only`} role="status">{playback.paused ? "Paused" : ""}</span>
        </> : null}
        <span className={styles.arrows} hidden={count < 2}>
          <IconButton aria-label={`Previous featured ${kind}`} className={styles.previous} onClick={(event) => move(-1, event.detail === 0)} size="touch" variant="secondary"><ArrowUpIcon /></IconButton>
          <IconButton aria-label={playback.automatic ? `Pause featured ${kind}` : `Play featured ${kind}`} disabled={playback.pending} onClick={playback.togglePlayback} ref={playbackButton} size="touch" variant="secondary">
            <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24"><path d={playback.automatic ? "M9 5V19M15 5V19" : "M8 5 19 12 8 19Z"} /></svg>
          </IconButton>
          <IconButton aria-label={`Next featured ${kind}`} className={styles.next} onClick={(event) => move(1, event.detail === 0)} size="touch" variant="secondary"><ArrowUpIcon /></IconButton>
        </span>
      </div>
    </div>
  );
}
