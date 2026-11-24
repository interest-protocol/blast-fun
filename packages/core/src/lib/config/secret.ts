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

/**
 * A base64 key of exactly 32 bytes. Node's lenient decoder is kept on
 * purpose: a strict one could reject a key that works today.
 */
export function requiredKey32(environment: Environment, name: string): Buffer {
  const key = optionalKey32(environment, name);
  if (key === null) {
    throw new Error(`${name} must be set.`);
  }
  return key;
}

/** As `requiredKey32`, but unset or empty is null. Set but malformed still fails. */
export function optionalKey32(environment: Environment, name: string): Buffer | null {
  const value = environment[name];
  if (!value) {
    return null;
  }
  const key = Buffer.from(value, "base64");
  if (key.byteLength !== 32) {
    throw new Error(`${name} must be a base64 key of 32 bytes.`);
  }
  return key;
}

/** A credential issued by someone else (Privy, X): presence only. */
export function requiredValue(environment: Environment, name: string): string {
  const value = environment[name];
  if (!value) {
    throw new Error(`${name} must be set.`);
  }
  return value;
}
