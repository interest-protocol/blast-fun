import { isSuiAddress } from "@blast/core/lib/sui/ids.ts";

/** A presale ID is a Sui object ID written as `0x` and 64 lowercase hex digits. */
export function isPresaleId(value: string): boolean {
  return isSuiAddress(value);
}
