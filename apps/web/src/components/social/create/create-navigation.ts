"use client";

import { useEffect } from "react";

import type { CreateIssue } from "@blast/core/web/contracts/create.ts";

import { blurAllocationAddress } from "#web/lib/sui-address-input.ts";

import { createStore } from "./create-store";
import { issueStep, readStepHash, stepHash, type CreateStep } from "./create-steps";

const STEP_BODY = "[data-create-page] [data-create-step]";

/** Brings the step's top into view and moves focus to it, once it has rendered. */
function showStep(): void {
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(STEP_BODY)?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: "instant" });
  });
}

/**
 * Opens a step: the step bar, Continue, Back and Review's Edit links. Each
 * opening is a history entry (`#raise`), so Back returns to the step before;
 * the draft, its uploads and its validation state are untouched.
 */
export function goToStep(step: CreateStep): void {
  if (createStore.get().step !== step) {
    blurAllocationAddress();
    createStore.set({ step });
  }
  if (location.hash !== stepHash(step)) history.pushState(history.state, "", stepHash(step));
  showStep();
}

/**
 * "Continue to review" and Publish (the design's `crReview`): with issues,
 * every error shows and the page opens the first one's step and field;
 * without, Review opens.
 */
export function review(issues: readonly CreateIssue[]): void {
  const first = issues[0];
  if (!first) {
    goToStep("review");
    return;
  }
  createStore.set((current) => ({
    tried: true,
    step: issueStep(first),
    flash: { section: first.section, path: first.path, nonce: (current.flash?.nonce ?? 0) + 1 },
  }));
}

/** Opens a part of a step named by a link (`#cr-join`) and moves focus to it. */
function showSection(section: string): void {
  requestAnimationFrame(() => {
    const target = document.getElementById(`cr-${section}`);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ behavior: "instant", block: "start" });
  });
}

/**
 * The URL names the step on screen. A hash opens its step (and a part's
 * `#cr-…` link its part) on load and on Back and Forward; a step opened
 * without a link (a fix, a fresh draft) replaces the hash instead of adding
 * an entry.
 */
export function useStepLocation(step: CreateStep): void {
  // After the page's own layout effects, which may start the draft over (and with it the step).
  useEffect(() => {
    const follow = () => {
      const target = readStepHash(location.hash);
      if (!target) return;
      if (createStore.get().step !== target.step) createStore.set({ step: target.step });
      if (target.section) showSection(target.section);
    };
    follow();
    window.addEventListener("hashchange", follow);
    window.addEventListener("popstate", follow);
    return () => {
      window.removeEventListener("hashchange", follow);
      window.removeEventListener("popstate", follow);
    };
  }, []);
  useEffect(() => {
    const current = createStore.get().step;
    const named = readStepHash(location.hash);
    if (named?.step === current || (named === null && current === "token")) return;
    history.replaceState(history.state, "", stepHash(current));
  }, [step]);
}
