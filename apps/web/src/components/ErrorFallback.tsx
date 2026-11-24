"use client";

import { Button, ButtonLink } from "#web/components/blast-ui/Button.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import styles from "./ErrorFallback.module.css";

// The error boundaries render outside every route layout, so outside
// `BlastUiRoot`: `data-blast-ui` gives this screen the shared tokens, and each
// boundary file imports blast-ui.css itself.
export function ErrorFallback({ error, retry }: Readonly<{ error: Error & { digest?: string }; retry: () => void }>) {
  const reference = error.digest && /^[a-zA-Z0-9_-]{1,128}$/.test(error.digest) ? error.digest : null;
  return (
    <div data-blast-ui="">
      <main className={styles.page}>
        <EmptyState
          framed
          heading={1}
          role="alert"
          title="This page could not load"
          action={
            <div className={styles.actions}>
              <Button variant="ink" size="sm" onClick={retry} type="button">Try again</Button>
              <ButtonLink variant="ghost" size="sm" href="/">Return to Blast</ButtonLink>
            </div>
          }
        >
          Your saved drafts are still available.
          <span className={styles.code}>Code: page_unavailable.{reference ? ` Reference: ${reference}.` : ""}</span>
        </EmptyState>
      </main>
    </div>
  );
}
