"use client";

import { useEffect } from "react";

import { SHELL_PHONE_QUERY } from "./nav";

/** Scroll past this before the tab bar may hide, so the page head always shows it. */
const TOP_ZONE = 64;
/** Ignore smaller moves, so a resting finger does not flicker the bar. */
const JITTER = 8;
/** A page with less to scroll than this keeps the bar, so it does not hide and return in one flick. */
const SHORT_PAGE = 200;

/**
 * Hides the phone tab bar while the reader scrolls down and brings it back on
 * any scroll up, near the top, and at the end of the page. It writes
 * `data-tabbar="hidden"` on the root element; AppShell's phone CSS slides the
 * bar away and pages move their own docked bars with it.
 *
 * A scroll-state container query (`scrolled: bottom`) does this with no script,
 * but Safari has no scroll-state queries yet. Delete this hook once that query
 * is Baseline: check that the bar hides and returns on an iPhone.
 */
export function useTabBarAutoHide() {
  useEffect(() => {
    const root = document.documentElement;
    const phone = window.matchMedia(SHELL_PHONE_QUERY);
    let last = window.scrollY;
    let frame = 0;
    const update = () => {
      frame = 0;
      const y = window.scrollY;
      const delta = y - last;
      const room = root.scrollHeight - window.innerHeight;
      if (!phone.matches || room < SHORT_PAGE || y <= TOP_ZONE || y >= room - 2 || delta <= -JITTER) {
        delete root.dataset.tabbar;
        last = y;
      } else if (delta >= JITTER) {
        root.dataset.tabbar = "hidden";
        last = y;
      }
    };
    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
      delete root.dataset.tabbar;
    };
  }, []);
}
