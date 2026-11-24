// The processes Render runs, one row each: `start.sh <name>` starts the row's worker. A row loads
// its module only when chosen, so one worker never loads another's dependencies.

type Environment = Readonly<Record<string, string | undefined>>;

type WorkerEntry = Readonly<{
  /** The values the process's fatal lines must redact. */
  secrets(environment: Environment): readonly string[];
  run(environment: Environment, signal: AbortSignal): Promise<void>;
}>;

type WorkerProcess = Readonly<{
  /** Prefix of the process's `crashed` and `config_error` lines. */
  metricPrefix: "worker" | "social.worker";
  load(): Promise<WorkerEntry>;
}>;

async function chainWorkerSecrets() {
  return (await import("#workers/modules/worker-runtime/log.ts")).workerSecrets;
}

export const WORKER_PROCESSES = {
  "blast-keeper": {
    metricPrefix: "worker",
    load: async () => ({
      secrets: await chainWorkerSecrets(),
      run: (await import("#workers/modules/blast-keeper-worker/main.ts")).runBlastKeeper,
    }),
  },
  "vault-rewards": {
    metricPrefix: "worker",
    load: async () => ({
      secrets: await chainWorkerSecrets(),
      run: (await import("#workers/modules/vault-rewards/main.ts")).runVaultRewards,
    }),
  },
  "rewards-planner": {
    metricPrefix: "worker",
    load: async () => ({
      secrets: await chainWorkerSecrets(),
      run: (await import("#workers/modules/rewards-planner/main.ts")).runRewardsPlanner,
    }),
  },
  "vault-buyback": {
    metricPrefix: "worker",
    load: async () => ({
      secrets: await chainWorkerSecrets(),
      run: (await import("#workers/modules/vault-buyback/main.ts")).runBuybackWorker,
    }),
  },
  // Off unless BLAST_SOCIAL_ENABLED is "true" or "team". When off, it logs `social.worker.disabled`
  // and exits 0 without connecting.
  social: {
    metricPrefix: "social.worker",
    load: async () => {
      const { runSocialWorker, socialWorkerSecrets } = await import("#workers/modules/social/worker/main.ts");
      return {
        secrets: socialWorkerSecrets,
        run: async (environment, signal) => {
          if ((await runSocialWorker(environment, signal)) === "disabled") {
            console.info(JSON.stringify({ metric: "social.worker.disabled", at: new Date().toISOString() }));
          }
        },
      };
    },
  },
} as const satisfies Record<string, WorkerProcess>;

type WorkerName = keyof typeof WORKER_PROCESSES;

export const WORKER_NAMES = Object.keys(WORKER_PROCESSES) as WorkerName[];

export function isWorkerName(name: string | undefined): name is WorkerName {
  return name !== undefined && Object.hasOwn(WORKER_PROCESSES, name);
}
