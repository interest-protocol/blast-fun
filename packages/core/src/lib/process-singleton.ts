/**
 * One value per server process. Next.js loads a module once per bundle layer,
 * so route handlers and page rendering each get their own copy of a module in
 * the same process, and a module-level `let` gives each copy its own "shared"
 * object. The value lives on globalThis under a registered symbol instead, so
 * every copy of the module finds the same one.
 */
export function processSingleton<T>(key: string, create: () => T): T {
  const slots = globalThis as unknown as Record<symbol, T | undefined>;
  return (slots[singletonKey(key)] ??= create());
}

function singletonKey(key: string): symbol {
  return Symbol.for(`blast.${key}`);
}

/** Remove an existing singleton from the process without constructing it. */
export function takeProcessSingleton<T>(key: string): T | undefined {
  const slots = globalThis as unknown as Record<symbol, T | undefined>;
  const slot = singletonKey(key);
  const value = slots[slot];
  delete slots[slot];
  return value;
}
