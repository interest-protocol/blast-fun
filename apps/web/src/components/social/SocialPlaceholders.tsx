import { ButtonLink } from "#web/components/blast-ui/Button.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { MissingPageMarker } from "#web/components/blast-ui/shell-missing-page.tsx";
import { diagnosticMessage } from "#web/lib/errors.ts";

import styles from "./SocialPlaceholder.module.css";

/**
 * A social path with nothing behind it (FEATURE-MAP §0.3, "Nothing here"):
 * an unknown profile or a page that does not exist, inside the app shell.
 * The title stays the page's level-one heading.
 */
export function SocialNotFound() {
  // The shell marks no rail item current: a missing page belongs to no section.
  return (<>
    <MissingPageMarker />
    <EmptyState
      action={<ButtonLink href="/" size="sm">Back home</ButtonLink>}
      className={styles.missing}
      framed
      heading={1}
      title="Nothing here"
    >
      This page doesn’t exist.
    </EmptyState>
  </>);
}

/** A profile the server could not read: says so, and offers the same address again. */
export function SocialProfileUnavailable({ callsign }: Readonly<{ callsign: string }>) {
  return (
    <EmptyState
      action={<ButtonLink href={`/@${callsign}`} prefetch={false} size="sm">Try again</ButtonLink>}
      className={styles.missing}
      framed
      role="alert"
      title="This profile couldn’t load"
    >
      {diagnosticMessage("Nothing changed. Check your connection and try again.", { code: "service_unavailable" })}
    </EmptyState>
  );
}
