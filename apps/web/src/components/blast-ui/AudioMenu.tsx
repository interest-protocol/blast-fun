"use client";

import clsx from "clsx";
import { useSyncExternalStore } from "react";
import { createStore } from "zustand/vanilla";

import { useFeelSound } from "#web/components/blast-feel/FeelProvider.tsx";

import styles from "./AppShell.module.css";
import { BlastMenu, BlastMenuCheckboxItem, BlastMenuCheckboxItemIndicator, BlastMenuTrigger } from "./BlastMenu.tsx";
import { IconButton } from "./Button.tsx";
import { CheckIcon } from "./Icons.tsx";
import { accountMenuPlacement } from "./menu-placement.ts";

const MUSIC_URL = "/audio/cozy-vinyl-groove.mp3";

const playback = createStore<"paused" | "playing" | "failed">()(() => "paused");
let player: HTMLAudioElement | undefined;

function musicPlayer(): HTMLAudioElement {
  if (player) return player;

  // The player belongs to the document, which outlives the navigation shell.
  const audio = new Audio();
  audio.loop = true;
  audio.preload = "none";
  audio.onplay = () => {
    if (!audio.paused) playback.setState("playing");
  };
  audio.onpause = () => {
    if (audio.paused && playback.getState() !== "failed") playback.setState("paused");
  };
  audio.onerror = () => playback.setState("failed");
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) audio.pause();
  });
  player = audio;
  return audio;
}

function toggleMusic() {
  const audio = musicPlayer();
  if (!audio.paused) {
    audio.pause();
    return;
  }

  playback.setState("paused");
  if (!audio.getAttribute("src") || audio.error) audio.src = MUSIC_URL;
  void audio.play().catch((error: unknown) => {
    if (error instanceof DOMException && error.name === "AbortError") return;
    playback.setState("failed");
  });
}

const SPEAKER_ON = (
  <>
    <path d="M5 9.5h3.2L12.5 6v12l-4.3-3.5H5z" />
    <path d="M15.5 9.2a4 4 0 0 1 0 5.6M18 7a7 7 0 0 1 0 10" />
  </>
);

const SPEAKER_OFF = (
  <>
    <path d="M5 9.5h3.2L12.5 6v12l-4.3-3.5H5z" />
    <path d="m16 10 4 4M20 10l-4 4" />
  </>
);

function Speaker({ on }: Readonly<{ on: boolean }>) {
  return (
    <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" viewBox="0 0 24 24">
      {on ? SPEAKER_ON : SPEAKER_OFF}
    </svg>
  );
}

/** One entry point for the site's effects and the optional background track. */
export function AudioMenu({ className, onToggle }: Readonly<{
  className?: string;
  onToggle?: (on: boolean) => void;
}>) {
  const { soundEnabled, setSoundEnabled } = useFeelSound();
  const music = useSyncExternalStore(playback.subscribe, playback.getState, playback.getInitialState);
  const playing = music === "playing";
  const failed = music === "failed";

  return <>
    <BlastMenu
      anchored
      className={clsx(styles.menu, styles.audioMenu)}
      label="Audio"
      placement={accountMenuPlacement}
      trigger={<BlastMenuTrigger render={<IconButton
        aria-label="Audio"
        className={className}
        title="Audio"
        size="chip"
      >
        <Speaker on={soundEnabled || playing} />
      </IconButton>} />}
    >
      <BlastMenuCheckboxItem
        className={styles.mitem}
        checked={soundEnabled}
        data-feel-sound=""
        onCheckedChange={onToggle ?? setSoundEnabled}
      >
        <span className={styles.mtext}>Sound effects</span>
        <BlastMenuCheckboxItemIndicator aria-hidden="true"><CheckIcon /></BlastMenuCheckboxItemIndicator>
      </BlastMenuCheckboxItem>
      <BlastMenuCheckboxItem
        className={styles.mitem}
        checked={playing}
        data-feel-sound=""
        onCheckedChange={toggleMusic}
      >
        <span className={styles.mtext}>Background music{failed && <span aria-hidden="true">Playback failed. Try again.</span>}</span>
        <BlastMenuCheckboxItemIndicator aria-hidden="true"><CheckIcon /></BlastMenuCheckboxItemIndicator>
      </BlastMenuCheckboxItem>
    </BlastMenu>
    <span aria-live="polite" className="sr-only">{failed ? "Background music could not play. Try again." : ""}</span>
  </>;
}
