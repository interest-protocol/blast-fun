type Environment = Readonly<Record<string, string | undefined>>;

/** Every shared secret this repo issues itself is at least this long. */
export const MINIMUM_SECRET_LENGTH = 32;

/**
 * A secret this repo issues, at least `MINIMUM_SECRET_LENGTH` characters.
 * The value is returned exactly as set, so HMACs keyed with it do not change.
 * Errors name the variable, never the value.
 */
export function requiredSecret(environment: Environment, name: string): string {
  const value = optionalSecret(environment, name);
  if (value === null) {
    throw new Error(`${name} must be set.`);
  }
  return value;
}

/** As `requiredSecret`, but unset or empty is null. Set but short still fails. */
export function optionalSecret(environment: Environment, name: string): string | null {
  const value = environment[name];
  if (!value) {
    return null;
  }
  if (value.length < MINIMUM_SECRET_LENGTH) {
    throw new Error(`${name} must be at least ${MINIMUM_SECRET_LENGTH} characters.`);
  }
  return value;
}

/** A credential issued by someone else (Privy, X): presence only. */
export function requiredValue(environment: Environment, name: string): string {
  const value = environment[name];
  if (!value) {
    throw new Error(`${name} must be set.`);
  }
  return value;
}
