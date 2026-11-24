"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { SocialAccountState } from "../../social-account-client";
import type { SocialAccountSessionStatus } from "../../use-social-account-session";
import type { AccessTokenSource } from "../../social-fetch";
import { settingsQuery } from "../../queries";
import { workspaceOwnerFromSession } from "./entry-owner";
import type { ActionPreference } from "./ActionConfirmation";

export type ActionAccountSession = SocialAccountState & {
  sessionStatus?: SocialAccountSessionStatus;
  sessionIdentity?: string;
};
type CurrentActions = Readonly<{
  actor_key: string;
  authenticated: boolean;
  confirmation: ActionPreference;
}>;
const pending: CurrentActions = {
  actor_key: "pending",
  authenticated: false,
  confirmation: { status: "pending" },
};
const Context = createContext<CurrentActions>(pending);
const noToken = async () => null;
const AccountContext = createContext<Readonly<{
  accountState?: ActionAccountSession;
  getAccessToken: AccessTokenSource;
}>>({ getAccessToken: noToken });

/** Private Data follows live authentication even when a guest layout stays open. */
export const useCurrentBlastAccount = () => useContext(AccountContext);

/** Financial authority follows live auth, independently of the entry's retained layout owner. */
export function BlastActionProvider({
  accountState,
  getAccessToken,
  children,
}: Readonly<{
  accountState?: ActionAccountSession;
  getAccessToken?: AccessTokenSource;
  children: ReactNode;
}>) {
  const owner = accountState
    ? workspaceOwnerFromSession(accountState)
    : { status: "pending" as const };
  const accountId =
    owner.status === "ready" && owner.owner.kind === "account"
      ? owner.owner.account_id
      : undefined;
  const options = settingsQuery(getAccessToken ?? noToken, accountId, accountState?.sessionIdentity ?? "");
  // A new principal must read its own answer even if a previous session used this account ID.
  const query = useQuery({
    ...options,
    enabled: !!accountId && !!getAccessToken,
    retry: false,
    staleTime: 0,
  });
  let value = pending;
  if (owner.status === "error")
    value = {
      ...pending,
      actor_key: `error:${accountState?.sessionIdentity ?? ""}`,
      confirmation: { status: "error" },
    };
  if (owner.status === "ready" && owner.owner.kind === "guest")
    value = {
      actor_key: "guest",
      authenticated: false,
      confirmation: { status: "ready", enabled: false },
    };
  if (accountId)
    value = {
      actor_key: `account:${accountId}:${accountState?.sessionIdentity ?? ""}`,
      authenticated: true,
      confirmation: settingsConfirmation(query, !!getAccessToken),
    };
  return (
    <AccountContext value={{ accountState, getAccessToken: getAccessToken ?? noToken }}>
      <Context value={value}>{children}</Context>
    </AccountContext>
  );
}
export const useCurrentBlastActions = () => useContext(Context);

function settingsConfirmation(query: UseQueryResult<{ blast_mode_confirm_actions: boolean }>, hasToken: boolean): ActionPreference {
  if (query.isFetching || query.isPending || !hasToken) return { status: "pending" };
  if (query.isError) return { status: "error", retry: () => { void query.refetch(); } };
  return { status: "ready", enabled: query.data.blast_mode_confirm_actions };
}
