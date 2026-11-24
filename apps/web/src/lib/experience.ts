type Environment = Readonly<Record<string, string | undefined>>;

/** Legacy Mission Control API routes are enabled only when the server sets exactly "true". */
export function isBlastExperienceEnabled(environment: Environment = process.env): boolean {
  return environment.BLAST_EXPERIENCE_ENABLED === "true";
}
