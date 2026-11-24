/** A canonical Sui object id or address: `0x` and 64 lowercase hex digits. */
export const SUI_OBJECT_ID_SOURCE = "0x[0-9a-f]{64}";
export const SUI_OBJECT_ID_PATTERN = new RegExp(`^${SUI_OBJECT_ID_SOURCE}$`);
export const SUI_ADDRESS_INPUT_PATTERN = /^0x[0-9a-fA-F]{1,64}$/;

const COIN_TYPE_SOURCE = `${SUI_OBJECT_ID_SOURCE}::[A-Za-z_][A-Za-z0-9_]{0,127}::[A-Za-z_][A-Za-z0-9_]{0,127}`;
/** A canonical coin type, `0x<64 hex>::<module>::<Name>`; Move caps an identifier at 128 characters. */
export const COIN_TYPE = new RegExp(`^${COIN_TYPE_SOURCE}$`);
/** `COIN_TYPE`, optionally followed by its type arguments (`<...>`). */
export const COIN_TYPE_WITH_GENERICS = new RegExp(`^${COIN_TYPE_SOURCE}(<.+>)?$`);

export function isSuiAddress(value: unknown): value is string {
  return typeof value === "string" && SUI_OBJECT_ID_PATTERN.test(value);
}

/** User input may use short addresses and uppercase hex digits. */
export function isSuiAddressInput(value: unknown): value is string {
  return typeof value === "string" && SUI_ADDRESS_INPUT_PATTERN.test(value);
}

/** Typed input that spells a whole Sui address, `0x` and 64 hex digits in either case, trimmed, before it is normalized. */
export function isWholeSuiAddressInput(value: string): boolean {
  return /^0x[0-9a-f]{64}$/i.test(value.trim());
}
