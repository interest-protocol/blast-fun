import { createStore } from "zustand/vanilla";

const MUSIC_URL = "/audio/cozy-vinyl-groove.mp3";
const MUSIC_KEY = "blast.backgroundMusic";

type MusicState = "off" | "paused" | "starting" | "playing" | "blocked" | "failed";

export const backgroundMusic = createStore<MusicState>()(() => "off");
let player: HTMLAudioElement | undefined;
let restored = false;
let playAttempt = 0;
let gestureRetry: AbortController | undefined;

/** Restore once per document, even if navigation replaces the Audio menu. */
export function restoreBackgroundMusic() {
  if (restored) return;
  restored = true;
  let enabled = false;
  try {
    enabled = window.sessionStorage.getItem(MUSIC_KEY) === "true";
  } catch {
    // A browser that denies storage can still play music for this visit.
  }
  if (enabled) playMusic();
}

export function setBackgroundMusic(enabled: boolean) {
  try {
    window.sessionStorage.setItem(MUSIC_KEY, String(enabled));
  } catch {
    // Keep the choice for this document when storage is unavailable.
  }
  if (enabled) {
    playMusic();
  } else {
    playAttempt += 1;
    clearGestureRetry();
    backgroundMusic.setState("off");
    player?.pause();
  }
}

function musicPlayer(): HTMLAudioElement {
  if (player) return player;

  const audio = new Audio();
  audio.loop = true;
  audio.preload = "none";
  audio.onpause = () => {
    if (audio.paused && backgroundMusic.getState() === "playing") backgroundMusic.setState("paused");
  };
  audio.onerror = () => {
    if (backgroundMusic.getState() === "off") return;
    playAttempt += 1;
    clearGestureRetry();
    backgroundMusic.setState("failed");
  };
  player = audio;
  return audio;
}

function playMusic() {
  const audio = musicPlayer();
  clearGestureRetry();
  const attempt = ++playAttempt;
  if (!audio.getAttribute("src") || audio.error) audio.src = MUSIC_URL;
  backgroundMusic.setState("starting");
  void audio.play().then(() => {
    if (attempt === playAttempt) backgroundMusic.setState(audio.paused ? "paused" : "playing");
  }, (error: unknown) => {
    if (attempt !== playAttempt) return;
    if (error instanceof DOMException && error.name === "NotAllowedError") {
      backgroundMusic.setState("blocked");
      waitForGesture();
    } else {
      backgroundMusic.setState(error instanceof DOMException && error.name === "AbortError" ? "paused" : "failed");
    }
  });
}

function waitForGesture() {
  gestureRetry = new AbortController();
  const retry = (event: Event) => {
    if (!event.isTrusted || navigator.userActivation?.isActive === false) return;
    const activates = event.type === "click" || (event instanceof KeyboardEvent && (event.key === "Enter" || event.key === " "));
    if (activates && event.target instanceof Element && event.target.closest("[data-background-music-toggle]")) return;
    playMusic();
  };
  const options = { capture: true, signal: gestureRetry.signal };
  window.addEventListener("click", retry, options);
  window.addEventListener("keydown", retry, options);
}

function clearGestureRetry() {
  gestureRetry?.abort();
  gestureRetry = undefined;
}
