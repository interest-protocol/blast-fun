"use client";

import { CSPProvider } from "@base-ui/react/csp-provider";
import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";

import { StyleNonceContext } from "./style-nonce";

/**
 * The UI libraries' CSP and motion wiring, once per Blast UI root (OA-28,
 * `docs/product/social-feed/ui-libraries.md`):
 *
 * - base-ui's `CSPProvider` puts the nonce on the pre-hydration `<script>` of
 *   Tabs.Indicator and Slider.Thumb, and `disableStyleElements` stops the
 *   `<style precedence>` its ScrollArea and Select would render: React drops
 *   the nonce from such a style in server HTML, so `library-csp.css` carries
 *   that rule statically;
 * - motion's `MotionConfig` puts it on the `<style>` `AnimatePresence
 *   mode="popLayout"` inserts, and `reducedMotion="user"` turns transform and
 *   layout animations into instant changes when the reader asks for reduced
 *   motion;
 * - `StyleNonceContext` hands it to the rest (`DragDropProvider` from this
 *   folder).
 *
 * It renders no element of its own.
 */
export function LibraryProviders({ nonce, children }: Readonly<{ nonce: string | null; children: ReactNode }>) {
  const value = nonce ?? undefined;
  return (
    <StyleNonceContext value={value}>
      <CSPProvider disableStyleElements nonce={value}>
        <MotionConfig nonce={value} reducedMotion="user">
          {children}
        </MotionConfig>
      </CSPProvider>
    </StyleNonceContext>
  );
}
