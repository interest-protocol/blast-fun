"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, type MouseEvent, type ReactNode } from "react";

import { clearViewerQueries } from "#web/lib/query/invalidate.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";

import { useShellActions } from "#web/components/blast-ui/shell-actions.tsx";
import { ButtonLink, type ButtonLinkProps } from "#web/components/blast-ui/Button.tsx";

import { signInHref } from "./sign-in-gate";
import type { AccessTokenSource } from "./viewer-state-client";
import { ViewerStateProvider } from "./ViewerState";

/**
 * Who is reading a social page. A visitor (not signed in) reads everything
 * but acts on nothing. A signed-in viewer's `callsign` (null until known)
 * keeps controls from offering to follow themselves, and it may carry the
 * session's `signOut` and its Privy access token source (`getAccessToken`),
 * for owner-only reads such as the portfolio.
 */
export type SocialViewer = Readonly<{
  signedIn: boolean;
  sessionIdentity?: string;
  sessionPending?: boolean;
  callsign: string | null;
  signOut?: () => Promise<void>;
  getAccessToken?: AccessTokenSource;
}>;

const VISITOR: SocialViewer = { signedIn: false, callsign: null };
const SocialViewerContext = createContext<SocialViewer>(VISITOR);
const ViewerScopeContext = createContext<() => () => boolean>(() => () => true);

/** Captures the committed viewer. The returned check survives a child route unmount. */
export function useCaptureViewerScope(): () => () => boolean {
  return useContext(ViewerScopeContext);
}

/**
 * Supplies the viewer to every gate below it. Without it every reader is a
 * visitor: `SocialSession` mounts it with the Privy session's state, access
 * token and logout. It also mounts the viewer-state store (follows and
 * reactions, `ViewerState.tsx`), active only for a signed-in viewer, which
 * calls the social routes with `getAccessToken` and starts fresh for another
 * callsign without remounting the page.
 */
export function SocialViewerProvider({
  signedIn,
  sessionPending = false,
  sessionIdentity,
  callsign = null,
  accountId = null,
  getAccessToken,
  signOut,
  children,
}: Readonly<{
  signedIn: boolean;
  sessionPending?: boolean;
  sessionIdentity?: string;
  callsign?: string | null;
  accountId?: string | null;
  getAccessToken?: AccessTokenSource;
  signOut?: () => Promise<void>;
  children: ReactNode;
}>) {
  const viewer = useMemo<SocialViewer>(
    () => ({ signedIn, sessionPending, sessionIdentity: signedIn ? sessionIdentity : undefined, callsign: signedIn ? callsign : null, signOut, getAccessToken }),
    [signedIn, sessionPending, sessionIdentity, callsign, signOut, getAccessToken],
  );
  const captureScope = useViewerQueryScope(signedIn, accountId ?? callsign, sessionIdentity);
  return (
    <SocialViewerContext value={viewer}>
      {/* Always mounted (no key), so signing in or out never remounts the page and its shell. */}
      <ViewerStateProvider
        active={signedIn && !sessionPending}
        getAccessToken={getAccessToken}
        resetKey={signedIn ? JSON.stringify([sessionIdentity ?? "", accountId ?? callsign ?? ""]) : ""}
      >
        <ViewerScopeContext value={captureScope}>{children}</ViewerScopeContext>
      </ViewerStateProvider>
    </SocialViewerContext>
  );
}

/**
 * The server-state cache's viewer scope (OA-38): when a signed-in viewer
 * signs out or becomes another account, every viewer read
 * (`["blast","me",…]`) is dropped, so nothing one viewer read shows for
 * another. A visitor never reads any, and a callsign arriving for the same
 * session (null, then known) is the same viewer. A layout effect, so it runs
 * before the new viewer's reads subscribe.
 */
function useViewerQueryScope(signedIn: boolean, ownerId: string | null, sessionIdentity?: string): () => () => boolean {
  const client = useAppQueryClient();
  const previous = useRef<Readonly<{ signedIn: boolean; ownerId: string | null; sessionIdentity?: string }>>({ signedIn, ownerId, sessionIdentity });
  const generation = useRef(0);
  useLayoutEffect(() => () => { generation.current += 1; }, []);
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = { signedIn, ownerId: signedIn ? (ownerId ?? before.ownerId) : null, sessionIdentity };
    const signedOut = before.signedIn && !signedIn;
    const switched = before.signedIn && signedIn && before.ownerId !== null && ownerId !== null && before.ownerId !== ownerId;
    const principalChanged = before.sessionIdentity !== undefined && sessionIdentity !== undefined && before.sessionIdentity !== sessionIdentity;
    if (before.signedIn !== signedIn || switched || principalChanged) generation.current += 1;
    if (signedOut || switched || principalChanged) clearViewerQueries(client);
  }, [client, signedIn, ownerId, sessionIdentity]);
  return useCallback(() => {
    const owner = generation.current;
    return () => generation.current === owner;
  }, []);
}

/** The current viewer (a visitor without a `SocialViewerProvider`). */
export function useSocialViewer(): SocialViewer {
  return useContext(SocialViewerContext);
}

/**
 * The viewer, where a gated tap sends a visitor (sign-in, returning to the
 * current path), and the link's click handler: under the app shell it opens
 * the sign-in sheet over the page instead (FEATURE-MAP §0.3); the link stays
 * the fallback (no shell, no JavaScript, a new tab).
 */
export function useSignInGate(): Readonly<{ signedIn: boolean; sessionPending: boolean; signInHref: string; openSignIn: (event: MouseEvent) => void }> {
  const { signedIn, sessionPending = false } = useContext(SocialViewerContext);
  const run = useShellActions();
  return {
    signedIn,
    sessionPending,
    signInHref: signInHref(usePathname()),
    openSignIn: (event) => {
      if (sessionPending) { event.preventDefault(); return; }
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (run("openSignIn")) event.preventDefault();
    },
  };
}

/**
 * A control only a signed-in viewer can use (follow, react, "why", "Commit
 * too"). A visitor gets a link to `/sign-in?next=<current path>` with the
 * same label, which opens the sign-in sheet under the app shell; a signed-in
 * viewer gets a button that runs `onAction`.
 */
export function GatedAction({
  children,
  onAction,
  className,
}: Readonly<{ children: ReactNode; onAction?: () => void; className?: string }>) {
  const gate = useSignInGate();
  if (gate.sessionPending) return <button className={className} type="button" disabled aria-busy="true">{children}</button>;
  if (!gate.signedIn) {
    return (
      <Link className={className} href={gate.signInHref} onClick={gate.openSignIn} prefetch={false} data-gated="sign-in">
        {children}
      </Link>
    );
  }
  return (
    <button className={className} type="button" onClick={onAction}>
      {children}
    </button>
  );
}

/** The header's sign-in link for a visitor, returning to the current path; nothing once signed in. */
export function SignInLink({ className, variant }: Readonly<{ className?: string; variant?: ButtonLinkProps["variant"] }>) {
  const gate = useSignInGate();
  if (gate.signedIn || gate.sessionPending) return null;
  if (variant) return <ButtonLink className={className} href={gate.signInHref} onClick={gate.openSignIn} prefetch={false} size="sm" variant={variant}>Sign in</ButtonLink>;
  return (
    <Link className={className} href={gate.signInHref} onClick={gate.openSignIn} prefetch={false}>
      Sign in
    </Link>
  );
}
