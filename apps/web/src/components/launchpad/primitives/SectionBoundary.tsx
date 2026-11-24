"use client";

import { unstable_rethrow } from "next/navigation";
import { Component, Suspense, type ReactNode } from "react";

import { DataState, StateLine } from "./DataState";
import { capitalize } from "./data-state-model";
import styles from "./primitives.module.css";

/**
 * What a section shows when it failed to render. `heading` keeps a heading
 * the section owns (such as the page h1) when its content cannot render.
 */
export function SectionFailed({ subject, heading }: Readonly<{ subject: string; heading?: ReactNode }>) {
  return (
    <>
      {heading}
      <div className={styles.dataState} data-state="unavailable">
        <StateLine kind="unavailable">
          {capitalize(subject)} could not be shown. The rest of the page is unaffected. Reload the
          page to try again.
        </StateLine>
      </div>
    </>
  );
}

/**
 * Contains a section's render failure so sibling sections and the page stay
 * usable. On the server, Suspense turns a failure into the section's Loading
 * state and the browser retries it; a failure there shows SectionFailed.
 * Key it by the section's data identity to retry after navigation.
 *
 * Next's navigation errors (`notFound()`, `redirect()`) pass through to the
 * framework. Because the section streams, a slot's `notFound()` renders the
 * launchpad 404 as a soft 404 (HTTP 200, noindex). Decide page status in the
 * page, before its slots render, so a missing coin answers a real 404.
 */
export class SectionBoundary extends Component<
  Readonly<{ subject: string; heading?: ReactNode; children: ReactNode }>,
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(error: unknown) {
    unstable_rethrow(error);
    return { failed: true };
  }

  render() {
    const { subject, heading, children } = this.props;
    if (this.state.failed) return <SectionFailed subject={subject} heading={heading} />;
    return (
      <Suspense
        fallback={
          <>
            {heading}
            <DataState state={{ status: "loading" }} subject={subject}>
              {() => null}
            </DataState>
          </>
        }
      >
        {children}
      </Suspense>
    );
  }
}
