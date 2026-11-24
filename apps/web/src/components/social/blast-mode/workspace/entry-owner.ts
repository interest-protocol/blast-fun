import type { WorkspaceOwner, WorkspaceOwnerState } from "./workspace-context";
import type { SocialAccountSessionStatus } from "../../use-social-account-session";

/** D-001: the existing auth layer's settled signed-out answer confirms a guest. */
export function workspaceOwnerFromSession(
  session: Readonly<{
    status: "loading" | "error" | "signed_out" | "ready";
    account: Readonly<{ account_id: string }> | null;
    sessionStatus?: SocialAccountSessionStatus;
  }>,
): WorkspaceOwnerState {
  if (session.status === "loading" || session.sessionStatus === "pending")
    return { status: "pending" };
  if (session.status === "error" || session.sessionStatus === "refused")
    return { status: "error" };
  if (session.account)
    return {
      status: "ready",
      owner: { kind: "account", account_id: session.account.account_id },
    };
  if (session.status === "ready" || session.sessionStatus === "signed_out")
    return { status: "ready", owner: { kind: "guest" } };
  return { status: "error" };
}

/** Active exploration stays put through sign-in; an established private owner cannot change in place. */
export function workspaceEntryOwner(
  entry: WorkspaceOwner | null,
  current: WorkspaceOwnerState,
  identity?: Readonly<{ entry?: string; current?: string }>,
): WorkspaceOwnerState | Readonly<{ status: "ended" }> {
  if (!entry) return current;
  if (entry.kind === "guest") return { status: "ready", owner: entry };
  if (
    identity?.entry !== undefined &&
    identity.current !== undefined &&
    identity.entry !== identity.current
  )
    return { status: "ended" };
  if (
    current.status === "ready" &&
    (current.owner.kind !== "account" ||
      current.owner.account_id !== entry.account_id)
  )
    return { status: "ended" };
  return { status: "ready", owner: entry };
}
