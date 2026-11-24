import {
  createBrowserWorkspaceJournal,
  createWorkspaceJournal,
  type JournalStorage,
} from "./journal";
import type { Network } from "@blast/core/modules/social/blast-workspace/setup.ts";

type GuestJournal = ReturnType<typeof createWorkspaceJournal>;
const tabs = new WeakMap<Window, WeakMap<object, Map<Network, GuestJournal>>>();

/** The tab owns guest drafts; disposable UI only subscribes to them. */
export function guestWorkspaceJournal(
  network: Network,
  storage?: JournalStorage,
  retryRecovery = false,
): GuestJournal {
  let sources = tabs.get(window);
  if (!sources) {
    sources = new WeakMap();
    tabs.set(window, sources);
  }
  const source = storage ?? window;
  let journals = sources.get(source);
  if (!journals) {
    journals = new Map();
    sources.set(source, journals);
  }
  const current = journals.get(network);
  if (
    current &&
    !(retryRecovery && current.restore.status === "recovery_required")
  ) {
    return current;
  }
  current?.dispose();
  const scope = {
    actor: { kind: "guest" as const },
    chain: "sui" as const,
    network,
  };
  const journal = storage
    ? createWorkspaceJournal({ scope, storage })
    : createBrowserWorkspaceJournal(scope);
  journals.set(network, journal);
  return journal;
}
