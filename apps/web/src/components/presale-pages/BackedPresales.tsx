"use client";

import type { ReactNode } from "react";
import { PositionsList } from "#web/components/social/portfolio/HoldingsLists.tsx";
import { useAmountsHidden, useMePresales } from "#web/components/social/profile/use-profile-data.ts";
import { useShellClaimPath } from "#web/components/social/feed-ui/shell-bridge.tsx";
import { SignInLink, useSocialViewer } from "#web/components/social/SignInGate.tsx";
import { useHydrated } from "#web/components/ui-libraries/use-hydrated.tsx";
import { Button } from "#web/components/blast-ui/Button.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { useToastedClaims } from "#web/components/social/claim/ClaimButton.tsx";
import { PresaleRowsSkeleton } from "./PresalesSkeleton";
import { cx } from "./cx";

export function BackedPresales({ now, onBrowse }: Readonly<{ now: number; onBrowse?: () => void }>) {
  const viewer = useSocialViewer();
  const hydrated = useHydrated();
  const positions = useMePresales(true, true);
  const hidden = useAmountsHidden();
  const claims = useToastedClaims(useShellClaimPath(), { toastRefusals: true });
  const pending = !hydrated || viewer.sessionPending || positions.status === "loading";
  let content: ReactNode;
  if (pending) {
    content = <PresaleRowsSkeleton />;
  } else if (!viewer.signedIn) {
    content = (
      <EmptyState action={<SignInLink className={cx("btn btn-soft btn-sm")} />} framed title="Sign in to see the presales you’ve backed" />
    );
  } else if (viewer.callsign === null) {
    content = <EmptyState framed title="Finish setting up your account">Pick a callsign to see your backed presales.</EmptyState>;
  } else if (positions.status === "error") {
    content = (
      <EmptyState action={<Button onClick={positions.retry} size="sm">Try again</Button>} framed role="alert" title="Your backed presales couldn’t load">
        {positions.message}
      </EmptyState>
    );
  } else if (positions.status === "ready" && positions.value.positions.length) {
    content = <PositionsList classes={{ list: cx("backed-positions"), row: cx("backed-position") }} claims={claims} hidden={hidden} nowMs={now} positions={positions.value.positions} />;
  } else {
    content = <EmptyState action={onBrowse && <Button onClick={onBrowse} size="sm" variant="ghost">Browse presales</Button>} framed title="No backed presales yet" />;
  }
  return (
    <section aria-label="Your backed presales" aria-busy={pending || undefined} className={cx("backed-presales")}>
      {content}
    </section>
  );
}
