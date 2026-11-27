"use client";

import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";

import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { useSocialViewer } from "../SignInGate";
import { watchClaimReads } from "./claim-refresh";
import { createClaimRunner, NO_CLAIMS, type ClaimRunner, type ClaimSettled } from "./claim-runner";
import { CLAIM_IDLE, claimPathSupports, type ClaimKind, type ClaimPath, type ClaimTarget, type ClaimView } from "./claims";

/**
 * The claims Blast mode runs, one state per claimable thing, shared by every
 * button that claims it — Act now's (the dock's wallet and the phone sheet)
 * and the side panel's — so a claim started in one place reads `Claiming` in
 * all of them and a refusal shows wherever the reader looks next.
 */
export type Claims = Readonly<{
  /** Whether a claim path exists. Without one no claim button renders. */
  available: boolean;
  /** Whether the path can claim this kind; a button of a kind it cannot claim is not drawn. */
  supports: (kind: ClaimKind) => boolean;
  view: (key: string, claimed?: string, received?: string) => ClaimView;
  run: (target: ClaimTarget) => void;
}>;

const RunnerContext = createContext<Readonly<{ path: ClaimPath | undefined; scope: string | null; runner: ClaimRunner | null }> | null>(null);

/** One runner per signed-in shell; nested overlay providers keep the same owner. */
export function ClaimRunnerProvider({ path, children }: Readonly<{ path: ClaimPath | undefined; children: ReactNode }>) {
  const outer = useContext(RunnerContext);
  const scope = useSocialViewer().callsign;
  const runner = useMemo(() => outer !== null && outer.path === path && outer.scope === scope ? outer.runner : path ? createClaimRunner(path) : null, [outer, path, scope]);
  const owned = runner !== outer?.runner;
  useRunnerLifetime(owned ? runner : null);
  const value = useMemo(() => ({ path, scope, runner }), [path, scope, runner]);
  return <RunnerContext value={value}>{children}</RunnerContext>;
}

function useRunnerLifetime(runner: ClaimRunner | null) {
  const queries = useAppQueryClient();
  useEffect(() => {
    if (runner === null) return undefined;
    runner.resume();
    const stop = watchClaimReads(runner, queries);
    return () => { stop(); runner.dispose(); };
  }, [queries, runner]);
}

const NO_VIEWS: ReadonlyMap<string, ClaimView> = new Map();
const noSubscribe = () => () => undefined;

/** Use the shell runner, or own one for a standalone surface with its own path. */
export function useClaimsController(path: ClaimPath | undefined, settled?: ClaimSettled): Claims {
  const shared = useContext(RunnerContext);
  const scope = useSocialViewer().callsign;
  const supplied = shared !== null && shared.path === path && shared.scope === scope ? shared.runner : null;
  const local = useMemo(() => path && supplied === null ? createClaimRunner(path) : null, [path, supplied]);
  const runner = supplied ?? local;
  useRunnerLifetime(local);
  const views = useSyncExternalStore(runner?.subscribe ?? noSubscribe, runner?.snapshot ?? (() => NO_VIEWS), () => NO_VIEWS);
  return useMemo<Claims>(
    () =>
      runner === null
        ? NO_CLAIMS
        : {
          available: true,
          supports: (kind: ClaimKind) => claimPathSupports(path, kind),
          view: (key, claimed, received) => views.has(key) ? runner.view(key, claimed, received) : CLAIM_IDLE,
          run: (target) => runner.run(target, settled),
        },
    [path, runner, views, settled],
  );
}
