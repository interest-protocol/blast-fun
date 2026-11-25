"use client";

import clsx from "clsx";
import { useEffect, useSyncExternalStore } from "react";

import { useFeelSound } from "#web/components/blast-feel/FeelProvider.tsx";

import styles from "./AppShell.module.css";
import { backgroundMusic, restoreBackgroundMusic, setBackgroundMusic } from "./background-music.ts";
import { BlastMenu, BlastMenuCheckboxItem, BlastMenuCheckboxItemIndicator, BlastMenuTrigger } from "./BlastMenu.tsx";
import { IconButton } from "./Button.tsx";
import { CheckIcon } from "./Icons.tsx";
import { accountMenuPlacement } from "./menu-placement.ts";

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
  const music = useSyncExternalStore(backgroundMusic.subscribe, backgroundMusic.getState, backgroundMusic.getInitialState);
  const musicStatus = music === "blocked" ? "Starts when you interact." : music === "failed" ? "Playback failed." : "";
  useEffect(restoreBackgroundMusic, []);

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
        <Speaker on={soundEnabled || music === "playing"} />
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
        checked={music !== "off"}
        data-background-music-toggle=""
        data-feel-sound=""
        onCheckedChange={setBackgroundMusic}
      >
        <span className={styles.mtext}>Background music{musicStatus && <span aria-hidden="true">{musicStatus}</span>}</span>
        <BlastMenuCheckboxItemIndicator aria-hidden="true"><CheckIcon /></BlastMenuCheckboxItemIndicator>
      </BlastMenuCheckboxItem>
    </BlastMenu>
    <span aria-live="polite" className="sr-only">{musicStatus && ("Background music. " + musicStatus)}</span>
  </>;
}
