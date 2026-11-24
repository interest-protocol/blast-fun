type Environment = Readonly<Record<string, string | undefined>>;

export type DeploymentIdentity = Readonly<{
  /** Hashed into quota and cache namespaces exactly as read. */
  target: string;
  /** Hashed into quota and cache namespaces exactly as read; null in production. */
  branch: string | null;
  /** Production rules apply: Neon-only endpoints, https, released manifests. */
  production: boolean;
  /** `NODE_ENV` is not production: loopback fixtures and development keys are allowed. */
  localRun: boolean;
}>;

/**
 * Which deployment this process is, by its host's exclusive marker. A missing variable does not
 * throw: an unidentified process is local. Values are never trimmed and `??` keeps an empty string,
 * because target and branch feed a hash. A production marker the selected host contradicts throws,
 * so production rules are never dropped by a stray variable.
 */
export function deploymentIdentity(environment: Environment): DeploymentIdentity {
  const identity = selectedIdentity(environment);

  if (
    !identity.production &&
    (environment.VERCEL_ENV === "production" || environment.BLAST_WORKER_ENVIRONMENT === "production")
  ) {
    throw new Error(
      "Deployment markers disagree on production: check VERCEL_ENV, BLAST_WORKER_ENVIRONMENT and BLAST_DEPLOYMENT_TARGET.",
    );
  }

  return identity;
}

function selectedIdentity(environment: Environment): DeploymentIdentity {
  const localRun = environment.NODE_ENV !== "production";

  if (environment.VERCEL === "1") {
    return vercelIdentity(environment, localRun);
  }

  if (environment.BLAST_WORKER_ENVIRONMENT !== undefined) {
    const production = environment.BLAST_WORKER_ENVIRONMENT === "production";

    return production
      ? { target: "production", branch: null, production, localRun }
      : { target: "local", branch: "local", production, localRun };
  }

  if (environment.VERCEL_ENV !== undefined && environment.BLAST_DEPLOYMENT_TARGET === undefined) {
    throw new Error("VERCEL_ENV is set outside Vercel: set BLAST_DEPLOYMENT_TARGET instead.");
  }

  const production = environment.BLAST_DEPLOYMENT_TARGET === "production";

  return {
    target: environment.BLAST_DEPLOYMENT_TARGET ?? "local",
    branch: production ? null : (environment.BLAST_DEPLOYMENT_BRANCH ?? "local"),
    production,
    localRun,
  };
}

function vercelIdentity(environment: Environment, localRun: boolean): DeploymentIdentity {
  const production = environment.VERCEL_ENV === "production";

  return {
    target: environment.VERCEL_TARGET_ENV ?? environment.VERCEL_ENV ?? "local",
    branch: production ? null : (environment.VERCEL_GIT_COMMIT_REF ?? "local"),
    production,
    localRun,
  };
}
