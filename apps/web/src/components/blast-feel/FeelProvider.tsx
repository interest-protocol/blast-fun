"use client";

import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";

import type { FeelSignal } from "./feel-cues.ts";
import { documentVisible, type FeelPlayOptions } from "./feel-gate.ts";
import { startFeelAudio, type FeelAudio } from "./feel-mount.ts";
import { FeelScope } from "./feel-scope.ts";
import { setSoundEnabled, useSoundEnabled } from "./feel-sound-pref.ts";
import { useReducedMotion } from "#web/components/blast-ui/use-shell-prefs.ts";
import { browserAudioContext, type FeelAudioContextFactory } from "./feel-synth.ts";

/**
 * The Feel layer, mounted once for the app (FEEL-LAYER.md).
 *
 * Why a provider and not a module each component imports:
 *
 *  - **The press cue is page-wide.** It answers every link, button, row, tab
 *    and card — 134 of them on Home. One delegated capture listener does that;
 *    134 opt-ins could not be finished or kept finished.
 *  - **There must be exactly one audio context.** Browsers cap them, and the
 *    gate's phrases all share one master gain. A provider owns one, creates it
 *    lazily on the first cue after the reader's first gesture while sound is
 *    enabled, and closes it on unmount.
 *  - **One gate** (`feel-gate.ts`) in front of it: nothing before the first
 *    gesture, nothing while the tab is hidden, one press tap per 60 ms and one
 *    money sound per event.
 *  - **One lifecycle.** Every timer, frame, listener and stray node in the
 *    layer belongs to this provider's `FeelScope`, so the effect cleanup is a
 *    single `stop()` and `feelActive()` can prove nothing survived.
 *
 * What stays a hook rather than a provider: hold-to-blast (`use-feel-hold.ts`),
 * because it needs a specific button's rect, its sale and its commit — things
 * only that button has. Surfaces opt into that one.
 *
 * It renders nothing. There is no DOM in the server's output, so there is no
 * hydration surface, no layout shift and no server/client divergence; the ball
 * is created outside the React tree and only inside an event handler.
 */

export type FeelContextValue = Readonly<{
  /** Whether sound is on for this device. */
  soundEnabled: boolean;
  /** Turns sound on or off and remembers it. Turning it on confirms with one tap. */
  setSoundEnabled: (enabled: boolean) => void;
  /**
   * Plays one cue. A no-op while sound is off, before the reader's first
   * gesture, while the tab is hidden, or when the gate's caps refuse it
   * (`feel-gate.ts`). Never throws.
   */
  play: (signal: FeelSignal, options?: FeelPlayOptions) => void;
  /** False when the reader asked for reduced motion: the layer then animates nothing. */
  motion: boolean;
  /** Whether a provider is above: false means the layer is simply not mounted here. */
  provided: boolean;
  /**
   * The layer's lifecycle scope, for anything that needs a cleanable timer,
   * frame, listener or node. A ref rather than a value, so mounting the scope
   * costs no render and no consumer re-renders when it appears; it is read
   * inside handlers and effects, never during render.
   */
  scopeRef: RefObject<FeelScope | null>;
}>;

const NO_SCOPE: RefObject<FeelScope | null> = { current: null };

const INERT: FeelContextValue = Object.freeze({
  soundEnabled: false,
  setSoundEnabled: () => undefined,
  play: () => undefined,
  motion: true,
  provided: false,
  scopeRef: NO_SCOPE,
});

const FeelContext = createContext<FeelContextValue>(INERT);

/**
 * The layer, with no feel at all. Anything below reads the context and simply
 * does nothing, so a surface rendered outside the provider (a test, a dev page)
 * still works.
 */
export function useFeel(): FeelContextValue {
  return useContext(FeelContext);
}

/** Plays cues. The common case: `play({ kind: "land" })` after a commit lands. */
export function useFeelSound(): Pick<FeelContextValue, "play" | "soundEnabled" | "setSoundEnabled"> {
  const { play, soundEnabled, setSoundEnabled: set } = useFeel();
  return useMemo(() => ({ play, soundEnabled, setSoundEnabled: set }), [play, soundEnabled, set]);
}

/** Whether the layer may animate. False under `prefers-reduced-motion: reduce`. */
export function useFeelMotion(): boolean {
  return useFeel().motion;
}

export function FeelProvider({
  children,
  audioContext = browserAudioContext,
}: Readonly<{ children: ReactNode; audioContext?: FeelAudioContextFactory }>) {
  const soundEnabled = useSoundEnabled();
  const reducedMotion = useReducedMotion();
  const audioRef = useRef<FeelAudio | null>(null);
  const scopeRef = useRef<FeelScope | null>(null);

  // Nothing measures or touches the DOM until after mount, and the synth is
  // built here rather than during render so no audio object exists on the
  // server or in a render that is thrown away. It follows the sound flag
  // itself, synchronously with every change rather than a render later, so
  // while sound is off it never builds or resumes an audio context
  // (`startFeelAudio`).
  useEffect(() => {
    const own = new FeelScope(window);
    const audio = startFeelAudio({
      target: document,
      scope: own,
      audioContext,
      now: () => performance.now(),
      visible: documentVisible,
    });
    audioRef.current = audio;
    scopeRef.current = own;
    return () => {
      own.stop();
      audio.dispose();
      if (audioRef.current === audio) audioRef.current = null;
      if (scopeRef.current === own) scopeRef.current = null;
    };
  }, [audioContext]);

  // R3-13: a ball still flying when the route changes goes with the page it was on.
  const pathname = usePathname();
  const shownPath = useRef(pathname);
  useEffect(() => {
    if (shownPath.current === pathname) return;
    shownPath.current = pathname;
    scopeRef.current?.releaseNodes();
    audioRef.current?.play({ kind: "navigate" });
  }, [pathname]);

  const play = useCallback((signal: FeelSignal, options?: FeelPlayOptions) => {
    audioRef.current?.play(signal, options);
  }, []);

  const set = useCallback((enabled: boolean) => {
    // The synth follows the flag at once, so the confirming tap can already sound.
    setSoundEnabled(enabled);
    // Turning it on confirms itself, as the gate does; turning it off is silent.
    if (enabled) audioRef.current?.play({ kind: "tap" });
  }, []);

  const value = useMemo<FeelContextValue>(
    () => ({ soundEnabled, setSoundEnabled: set, play, motion: !reducedMotion, provided: true, scopeRef }),
    [soundEnabled, set, play, reducedMotion],
  );

  return <FeelContext value={value}>{children}</FeelContext>;
}
