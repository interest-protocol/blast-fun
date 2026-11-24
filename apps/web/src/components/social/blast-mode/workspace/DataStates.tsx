import type { ReactNode } from "react";

import { Button } from "#web/components/blast-ui/Button.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";

/** A Discover read that failed before any rows: the shared box, the title and one Retry. */
export function LoadFailed({ title, onRetry, retryLabel = "Retry" }: Readonly<{ title: string; onRetry: () => void; retryLabel?: string }>) {
  return <EmptyState action={<Button onClick={onRetry} size="sm" type="button" variant="secondary">{retryLabel}</Button>} compact role="alert" title={title} />;
}

/** A refresh that failed over rows already shown: one quiet line above them, with Retry at its end. */
export function RefreshFailed({ title, onRetry, retryLabel = "Retry", children = "Showing the previous result." }: Readonly<{ title: string; onRetry?: () => void; retryLabel?: string; children?: ReactNode }>) {
  return <EmptyState action={onRetry ? <Button onClick={onRetry} size="sm" type="button" variant="secondary">{retryLabel}</Button> : undefined} role="alert" row title={title}>{children}</EmptyState>;
}

/** A read that confirmed nothing is there: the title and at most one sentence. */
export function NothingHere({ title, children, action }: Readonly<{ title: ReactNode; children?: ReactNode; action?: ReactNode }>) {
  return <EmptyState action={action} compact role="status" title={title}>{children}</EmptyState>;
}

/** The read is more than a minute behind the chain: one quiet line, no action. */
export function DelayedNote() {
  return <EmptyState role="status" row title="Activity is delayed" />;
}
